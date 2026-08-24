"""Configuration: secrets (env only) and preferences (UI-editable, sane defaults).

Two strictly separated tiers, per Section 8.5 of the spec:

* ``Secrets`` are read from the environment ONLY. They are never persisted to an
  Elasticsearch index, never returned to the plugin, never logged. The wizard may
  push secret *values* to the backend at runtime (kept in process memory); the UI
  only ever sees a boolean "configured" status.
* ``Preferences`` carry working defaults so the suite runs out of the box. They are
  persisted in the ``tlsoc-agent-config`` index and are fully editable through the
  settings UI. Non-secret preferences override env-supplied defaults.

This module defines the schema and the loader for the secret tier. The preference
*store* (load/save against Elasticsearch) lives in ``app.stores.config_store``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, ClassVar, Literal, Mapping, Sequence

from pydantic import BaseModel, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .constants import CorrelationMode, EntityStrategy, EntityType, IndexRole, IngestMode, SourceType
from .evidence_fields import (
    DEFAULT_EVIDENCE_FIELDS,
    DEFAULT_EVIDENCE_MAX_CHARS_PER_EVENT,
    EVIDENCE_WILDCARD,
    MAX_EVIDENCE_MAX_CHARS_PER_EVENT,
    clamp_evidence_budget,
    is_wildcard,
    normalise_evidence_fields,
)
# Aliased so the module-level resolver is unambiguous next to the identically
# named ``Preferences.free_text_search_fields`` method that wraps it.
from .evidence_fields import free_text_search_fields as _resolve_free_text_search_fields
from .utils import dotted_get, iso_now, new_id, slug

# The provider names the per-role ModelConfig may carry. Widened in Round 3 Wave 2b to
# make the cloud-hosted providers (azure/bedrock/vertex) + any OpenAI-compatible
# self-hosted/aggregator endpoint first-class, so a ModelConfig can be constructed
# directly (no ``model_construct`` bypass) and the gateway's PROVIDER_REGISTRY can
# authenticate it. The legacy three (anthropic/openai/mock) keep working unchanged.
Provider = Literal[
    "anthropic", "openai", "mock", "azure", "bedrock", "vertex", "openai_compatible"
]

# Fresh-install completion defaults. Keep these in one place so the base
# ModelConfig and every role assignment cannot drift apart. Existing persisted
# preferences remain authoritative and alternate providers/models stay available.
DEFAULT_COMPLETION_PROVIDER: Provider = "openai"
DEFAULT_COMPLETION_MODEL = "gpt-5.6-luna"

# Bump this when the seeded rule catalog ships new built-in rules. Seeding only
# fires when the stored catalog is EMPTY or its ``rule_catalog_seed_version`` is
# missing/older than this value — operator-edited (non-empty) catalogs are NEVER
# overwritten (see ``maybe_seed_rule_catalog`` in ``app.stores.config_store``).
RULE_CATALOG_SEED_VERSION = 2  # v2: fix ModSec match field rule.id.keyword -> rule.id (#16)


# --------------------------------------------------------------------------- #
# Secrets — environment only.
# --------------------------------------------------------------------------- #
class Secrets(BaseSettings):
    """All secrets + connection wiring. Loaded from environment / ``.env``.

    The two ES credentials are a deliberate security split (see COMPATIBILITY.md):

    * ``es_api_key`` — a READ-ONLY API key scoped to the log indices (e.g.
      ``all-logs-*``). The agent's ``es_query`` tool uses ONLY this. It can never
      write, and it can never touch anything outside the scoped log pattern. This
      is non-negotiable #1.
    * ``es_mgmt_api_key`` — a key scoped to ``tlsoc-agent-*`` with read/write/
      create_index, used solely by the backend to own its OWN bookkeeping indices
      (cases/audit/usage/config/cursor). It can never read the log surface.

    Neither is ``kibana_system`` nor the ``elastic`` superuser.
    """

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- Elasticsearch connection (TLS, container-name DNS) ---
    es_url: str = "https://elasticsearch:9200"
    es_ca_cert: str | None = None          # path to ./certs/ca/ca.crt mounted into the container
    es_verify_certs: bool = True
    es_request_timeout: int = 30

    # --- Two scoped ES credentials (NEVER the superuser) ---
    es_api_key: str | None = None          # read-only, scoped to log indices
    es_mgmt_api_key: str | None = None     # read/write/create, scoped to tlsoc-agent-*

    # --- LLM provider keys ---
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    # Optional dedicated key for a self-hosted / LiteLLM (OpenAI-compatible) endpoint
    # (a LiteLLM master key / vLLM api-key). SECRET tier — env / in-memory only, NEVER
    # persisted, NEVER returned; the UI sees only a configured-boolean. The gateway
    # prefers it for the ``openai_compatible`` provider and falls back to
    # ``openai_api_key``; a no-auth local server needs none (base_url drives it).
    litellm_api_key: str | None = None

    # --- Round 3 Wave 2b cloud-LLM provider credentials (ALL optional + defaulted
    # None, SECRET tier — env / in-memory only, NEVER persisted, NEVER returned; the UI
    # sees only a configured-boolean via ``configured_status()``). These let the
    # gateway authenticate the cloud-hosted providers so a ``ModelConfig(provider=...)``
    # actually works end-to-end:
    #
    #   * Azure OpenAI   — an ``api-key`` + resource ``endpoint`` + api-version. The
    #                      model id is the Azure DEPLOYMENT name.
    #   * AWS Bedrock    — an IAM access-key pair + region (SigV4-signed, stdlib HMAC;
    #                      no boto3). ``aws_session_token`` carries an optional STS token.
    #   * Google Vertex  — a short-lived OAuth access token (``vertex_api_key``, carried
    #                      as the Bearer) + project + location. We do NOT mint the token
    #                      (no google-auth dep); the operator supplies it. ---
    azure_openai_api_key: str | None = None
    azure_openai_endpoint: str | None = None       # https://<resource>.openai.azure.com
    azure_openai_api_version: str | None = None     # e.g. "2024-10-21"
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    aws_session_token: str | None = None            # optional STS session token
    aws_region: str | None = None                   # e.g. "us-east-1"
    vertex_project: str | None = None
    vertex_location: str | None = None              # e.g. "us-central1"
    vertex_api_key: str | None = None               # short-lived OAuth access token (Bearer)

    # --- Enrichment keys ---
    abuseipdb_api_key: str | None = None
    virustotal_api_key: str | None = None
    # --- Round 3 multi-provider threat-intel keys (ALL optional + defaulted None,
    # SECRET tier — env / in-memory only, NEVER persisted, NEVER returned; the UI sees
    # only a configured-boolean via ``configured_status()``). A provider is only
    # queried when BOTH its ``EnrichmentConfig.use_*`` toggle is on AND (for key-gated
    # providers) its key is set. The keyless providers (shodan internetdb / ipinfo
    # lite / urlhaus / threatfox / malwarebazaar / rdap) need no key here. ---
    greynoise_api_key: str | None = None
    shodan_api_key: str | None = None
    censys_api_id: str | None = None
    censys_api_secret: str | None = None
    binaryedge_api_key: str | None = None
    ipinfo_token: str | None = None
    otx_api_key: str | None = None
    pulsedive_api_key: str | None = None
    spur_api_key: str | None = None
    xforce_api_key: str | None = None
    xforce_api_password: str | None = None
    urlscan_api_key: str | None = None
    hibp_api_key: str | None = None
    # Project Honeypot http:BL access key (key-gated, enables the ``honeypot`` provider
    # together with ``EnrichmentConfig.use_honeypot``). abuse.ch optional Auth-Key —
    # when set, the abuse.ch trio (URLhaus/ThreatFox/MalwareBazaar) sends it as the
    # ``Auth-Key`` header; unset keeps the keyless public-endpoint behaviour unchanged.
    honeypot_access_key: str | None = None
    abusech_auth_key: str | None = None
    # --- Round 11 enrichment expansion keys (ALL optional + defaulted None, SECRET
    # tier — same contract as above: env / in-memory only, never persisted, never
    # returned; the UI sees a configured-boolean only). Each pairs with an
    # ``EnrichmentConfig.use_*`` toggle; the keyless Round-11 providers
    # (circl hashlookup / dshield / onionoo / spamhaus / cymru mhr / robtex / crt.sh)
    # need no key here. ---
    crowdsec_api_key: str | None = None
    google_safebrowsing_api_key: str | None = None
    ipqualityscore_api_key: str | None = None
    ipdata_api_key: str | None = None
    apivoid_api_key: str | None = None
    maltiverse_api_key: str | None = None
    securitytrails_api_key: str | None = None
    criminalip_api_key: str | None = None
    netlas_api_key: str | None = None
    hybrid_analysis_api_key: str | None = None
    metadefender_api_key: str | None = None
    emailrep_api_key: str | None = None

    # --- Embeddings (defaults to the OpenAI key when blank) ---
    embedding_api_key: str | None = None

    # --- Caching ---
    redis_url: str = "redis://redis:6379/0"

    # --- Server ---
    backend_host: str = "0.0.0.0"
    backend_port: int = 8088
    log_level: str = "INFO"

    # --- Supervised application updates (standalone Compose profile only) ---
    # The ordinary API process never receives Docker or host credentials.  It may
    # only ask the separately installed updater supervisor to perform one of the
    # supervisor's fixed, signed-plan operations over this private Unix socket.
    # Absence of the socket is a truthful capability blocker (older/manual installs
    # need the documented one-time bootstrap); it never falls back to TCP or shell.
    update_supervisor_socket: str = "/run/agentic-soc-updater/control.sock"
    update_supervisor_timeout_seconds: float = Field(default=8.0, ge=1.0, le=30.0)
    # Preflight performs bounded signature and registry checks and may legitimately
    # take longer than the local status/job-control calls above.
    update_supervisor_preflight_timeout_seconds: float = Field(
        default=180.0, ge=30.0, le=300.0
    )

    # Private, server-only output directory for durable Jobs artifacts. The API
    # persists opaque artifact ids, never host paths, and derives every download
    # path beneath this root with containment/symlink checks.
    jobs_artifact_dir: str = "./data/job-artifacts"

    # --- Auth (Wave 2; OPTIONAL — default OFF so the no-auth "old version" is the
    # out-of-the-box behaviour and fully available). Flip ``auth_enabled`` to require
    # a JWT login on every /api route except the small public allowlist. Credentials
    # come from env: a single admin (``auth_admin_username`` + ``auth_admin_password``,
    # plaintext, hashed in memory at startup, NEVER stored/returned) and/or an
    # ``auth_users`` map of username -> PBKDF2 hash for multi-user. ---
    auth_enabled: bool = False
    auth_jwt_secret: str | None = None        # HS256 signing key; ephemeral+warn if unset when enabled
    auth_token_hours: int = 12
    auth_admin_username: str = "admin"
    auth_admin_password: str | None = None    # env-only plaintext; hashed at startup
    auth_users: dict[str, str] = Field(default_factory=dict)  # username -> pbkdf2 hash
    auth_cookie_secure: bool = False          # set True behind TLS (prod) so the cookie is HTTPS-only
    # When auth is ENABLED and the user store is EMPTY, seed a demo super_admin
    # (``Admin`` / ``Admin@123``) so the deployment is immediately usable. The demo
    # wants these creds to work directly, so must_change_password is False. Set this
    # False to require the OOBE first-admin flow instead. The env single-admin
    # (auth_admin_username/password) remains a separate fallback credential.
    auth_seed_admin: bool = True
    auth_seed_admin_username: str = "Admin"
    auth_seed_admin_password: str = "Admin@123"

    # --- Security middleware toggles (all independent of auth) ---
    # security headers ON by default (harmless, only affect backend-served
    # responses). Rate-limit + CSRF default OFF so the no-auth "old version" is
    # behaviourally UNCHANGED out of the box; enable them for a hardened profile.
    # NOTE: csrf_enabled currently requires the webui to echo the CSRF token (the
    # double-submit cookie is not yet issued on login) — enable only for API clients
    # that set X-CSRF-Token, or after wiring the webui. See SECURITY.md.
    security_headers_enabled: bool = True
    csrf_enabled: bool = False
    rate_limit_enabled: bool = False
    rate_limit_capacity: int = 120
    rate_limit_refill_per_second: float = 2.0

    # When true the backend persists to Elasticsearch; when ES is unreachable it
    # automatically falls back to an in-memory store so the spine still runs.
    es_store_enabled: bool = True

    # --- State backend selector (Epoch A: vendor-agnostic OWN-state) ---
    # Where the suite's OWN bookkeeping (cases/audit/usage/config/cursor/RAG
    # vectors) is persisted. The agent's READ-ONLY log surface ALWAYS stays on the
    # connector layer (es_api_key) regardless of this setting — this only moves the
    # suite's management state off Elasticsearch so self-hosting needs no ES.
    #
    #   "elasticsearch" (DEFAULT) — today's path: own-state in tlsoc-agent-* indices.
    #   "sqlite"                  — own-state in a local SQLite file (zero services).
    #   "postgres"                — own-state in PostgreSQL (+pgvector for RAG).
    #
    # SQL backends use ``state_db_url`` (a SQLAlchemy async URL). asyncpg/pgvector
    # are imported LAZILY, only when state_backend == "postgres", so a deployment
    # (or the test env) without those packages still imports + runs on SQLite/ES.
    state_backend: Literal["elasticsearch", "postgres", "sqlite"] = "elasticsearch"
    # e.g. "postgresql+asyncpg://user:pass@host:5432/tlsoc" or
    # "sqlite+aiosqlite:///./tlsoc.db". When None and state_backend is a SQL
    # backend, a sane default is derived (sqlite → ./tlsoc.db).
    state_db_url: str | None = None

    # Per-source connector secrets (e.g. a webhook bearer token, a Splunk API
    # token), keyed by SourceInstance id → {field: value}. Lives in the SECRET
    # tier (in memory / env), NEVER in Preferences/the config index (#10). The UI
    # only ever sees the field NAMES via SourceInstance.configured_secrets.
    connector_secrets: dict[str, dict[str, str]] = Field(default_factory=dict)

    # --- SSO / MFA secrets (Wave 2; SECRET tier — env / in-memory ONLY, NEVER
    # persisted to Preferences/the config doc, NEVER returned to the UI). ---
    # OIDC client secrets keyed by provider id (e.g. {"google": "..."}). Set at
    # runtime via POST /api/auth/sso/providers/{id}/secret (the connector-secret
    # pattern) or from the env (TLSOC_SSO_CLIENT_SECRETS as a JSON object).
    sso_client_secrets: dict[str, str] = Field(default_factory=dict)
    # Key used to obfuscate TOTP secrets at rest (auth/mfa.obfuscate_secret). When
    # blank, the effective key is derived from auth_jwt_secret (see mfa_server_key()).
    mfa_obfuscation_key: str | None = None

    # --- Notification channel secrets (Wave 4 / F5; SECRET tier — env / in-memory
    # ONLY, NEVER persisted to Preferences/the config doc, NEVER returned to the UI).
    # Per-channel: {channel_id: {field: value}} — e.g. {"email-1": {"password": "..."}},
    # {"slack-1": {"url": "https://hooks.slack.com/..."}}. Set at runtime via
    # POST /api/notifications/channels/{id}/secret (the connector-secret pattern) or
    # from the env (TLSOC_NOTIFICATION_SECRETS as a JSON object). ---
    notification_secrets: dict[str, dict[str, str]] = Field(default_factory=dict)

    def source_secrets(self, source_id: str) -> dict[str, str]:
        """The configured secret values for one source (empty if none)."""
        return dict(self.connector_secrets.get(source_id, {}))

    def sso_client_secret(self, provider_id: str) -> str:
        """The configured OIDC client secret for one provider (``""`` if none)."""
        return self.sso_client_secrets.get(provider_id, "") or ""

    def set_sso_client_secret(self, provider_id: str, value: str | None) -> None:
        """Set/clear one provider's OIDC client secret (value=None/"" clears it)."""
        if value is None or value == "":
            self.sso_client_secrets.pop(provider_id, None)
        else:
            self.sso_client_secrets[provider_id] = value

    def mfa_server_key(self) -> str:
        """The effective server key for at-rest MFA-secret obfuscation: the explicit
        ``mfa_obfuscation_key`` when set, else derived from ``auth_jwt_secret`` (so a
        deployment that already has a stable JWT secret needs no extra config). The
        derivation is namespaced so the JWT secret and the MFA key never collide."""
        if self.mfa_obfuscation_key:
            return self.mfa_obfuscation_key
        base = self.auth_jwt_secret or "tlsoc-mfa-fallback-key"
        return f"mfa-obf:{base}"

    def set_source_secret(self, source_id: str, field: str, value: str | None) -> None:
        """Set/clear one per-source secret field (value=None clears/revokes it)."""
        bucket = self.connector_secrets.setdefault(source_id, {})
        if value is None or value == "":
            bucket.pop(field, None)
        else:
            bucket[field] = value
        if not bucket:
            self.connector_secrets.pop(source_id, None)

    def notification_channel_secrets(self, channel_id: str) -> dict[str, str]:
        """The configured secret values for one notification channel (empty if none).
        SECRET tier — env/in-memory only, never persisted to Preferences (#10)."""
        return dict(self.notification_secrets.get(channel_id, {}))

    def notification_secret(self, channel_id: str, field: str = "secret") -> str:
        """One notification-channel secret field (``""`` when unset). The default
        field name ``secret`` holds the primary credential (SMTP password / API key /
        webhook URL / routing key / bot token) — channels resolve it generically."""
        return self.notification_secrets.get(channel_id, {}).get(field, "") or ""

    def set_notification_secret(self, channel_id: str, field: str, value: str | None) -> None:
        """Set/clear one notification-channel secret field (value=None clears it)."""
        bucket = self.notification_secrets.setdefault(channel_id, {})
        if value is None or value == "":
            bucket.pop(field, None)
        else:
            bucket[field] = value
        if not bucket:
            self.notification_secrets.pop(channel_id, None)

    def notification_configured_status(self) -> dict[str, bool]:
        """Per-channel configured-boolean view (channel_id -> any-secret-set). NEVER
        returns values — only whether each channel has a secret configured."""
        return {cid: bool(fields) for cid, fields in self.notification_secrets.items()}

    def provider_key(self, provider: Provider) -> str | None:
        if provider == "openai_compatible":
            # A self-hosted / LiteLLM endpoint prefers its dedicated key, falling back
            # to the OpenAI key (a no-auth local server needs neither — base_url drives it).
            return self.litellm_api_key or self.openai_api_key
        if provider == "openai":
            return self.openai_api_key
        if provider == "anthropic":
            return self.anthropic_api_key
        if provider == "azure":
            return self.azure_openai_api_key or self.openai_api_key
        if provider == "bedrock":
            return self.aws_access_key_id
        if provider == "vertex":
            return self.vertex_api_key
        return "mock"  # the mock provider needs no key

    def embedding_key(self) -> str | None:
        return self.embedding_api_key or self.openai_api_key

    def auth_user_map(self) -> dict[str, str]:
        """username -> PBKDF2 hash for the AuthService. Combines the ``auth_users``
        map with the single admin (plaintext ``auth_admin_password`` hashed in
        memory at startup). The plaintext is never stored or returned."""
        from .auth.passwords import hash_password

        users = dict(self.auth_users)
        if self.auth_admin_password and self.auth_admin_username not in users:
            users[self.auth_admin_username] = hash_password(self.auth_admin_password)
        return users

    def configured_status(self) -> dict[str, Any]:
        """Boolean-only view for the settings UI. NEVER returns values.

        Every value is a bool EXCEPT ``sso_client_secrets_by_id`` (an ADDITIVE
        ``provider_id -> bool`` map, Round-6 #21) — still boolean-only, never a value."""
        return {
            "es_api_key": bool(self.es_api_key),
            "es_mgmt_api_key": bool(self.es_mgmt_api_key),
            "openai_api_key": bool(self.openai_api_key),
            "anthropic_api_key": bool(self.anthropic_api_key),
            "litellm_api_key": bool(self.litellm_api_key),
            # Round 3 Wave 2b cloud-LLM provider credentials (configured-booleans only).
            "azure_openai_api_key": bool(self.azure_openai_api_key),
            "azure_openai_endpoint": bool(self.azure_openai_endpoint),
            "azure_openai_api_version": bool(self.azure_openai_api_version),
            "aws_access_key_id": bool(self.aws_access_key_id),
            "aws_secret_access_key": bool(self.aws_secret_access_key),
            "aws_session_token": bool(self.aws_session_token),
            "aws_region": bool(self.aws_region),
            "vertex_project": bool(self.vertex_project),
            "vertex_location": bool(self.vertex_location),
            "vertex_api_key": bool(self.vertex_api_key),
            "abuseipdb_api_key": bool(self.abuseipdb_api_key),
            "virustotal_api_key": bool(self.virustotal_api_key),
            # Round 3 Wave 2b enrichment keys (configured-booleans only).
            "honeypot_access_key": bool(self.honeypot_access_key),
            "abusech_auth_key": bool(self.abusech_auth_key),
            # Round 3 multi-provider threat-intel keys (configured-booleans only).
            "greynoise_api_key": bool(self.greynoise_api_key),
            "shodan_api_key": bool(self.shodan_api_key),
            "censys_api_id": bool(self.censys_api_id),
            "censys_api_secret": bool(self.censys_api_secret),
            "binaryedge_api_key": bool(self.binaryedge_api_key),
            "ipinfo_token": bool(self.ipinfo_token),
            "otx_api_key": bool(self.otx_api_key),
            "pulsedive_api_key": bool(self.pulsedive_api_key),
            "spur_api_key": bool(self.spur_api_key),
            "xforce_api_key": bool(self.xforce_api_key),
            "xforce_api_password": bool(self.xforce_api_password),
            "urlscan_api_key": bool(self.urlscan_api_key),
            "hibp_api_key": bool(self.hibp_api_key),
            # Round 11 enrichment expansion keys (configured-booleans only).
            "crowdsec_api_key": bool(self.crowdsec_api_key),
            "google_safebrowsing_api_key": bool(self.google_safebrowsing_api_key),
            "ipqualityscore_api_key": bool(self.ipqualityscore_api_key),
            "ipdata_api_key": bool(self.ipdata_api_key),
            "apivoid_api_key": bool(self.apivoid_api_key),
            "maltiverse_api_key": bool(self.maltiverse_api_key),
            "securitytrails_api_key": bool(self.securitytrails_api_key),
            "criminalip_api_key": bool(self.criminalip_api_key),
            "netlas_api_key": bool(self.netlas_api_key),
            "hybrid_analysis_api_key": bool(self.hybrid_analysis_api_key),
            "metadefender_api_key": bool(self.metadefender_api_key),
            "emailrep_api_key": bool(self.emailrep_api_key),
            "embedding_api_key": bool(self.embedding_key()),
            # Wave 2: configured-booleans only (never the values).
            "mfa_obfuscation_key": bool(self.mfa_obfuscation_key),
            # Legacy scalar (kept for compat): True iff ANY SSO provider has a secret.
            "sso_client_secrets": bool(self.sso_client_secrets),
            # ADDITIVE per-provider configured-boolean map (Round-6 #21): provider_id ->
            # bool. Lets the Security editor show an accurate "configured" badge PER
            # provider even with 2+ providers (the scalar above conflates them). NEVER
            # returns the secret value (#10) — only whether one is set.
            "sso_client_secrets_by_id": {
                pid: bool(val) for pid, val in (self.sso_client_secrets or {}).items()
            },
            # Wave 4: per-channel configured-booleans only (never the values).
            "notification_secrets": bool(self.notification_secrets),
        }


# --------------------------------------------------------------------------- #
# Preferences — UI-editable, persisted in tlsoc-agent-config.
# --------------------------------------------------------------------------- #
class ModelConfig(BaseModel):
    """Per-role model selection. Routed through the single gateway.

    ``base_url``/``api_version``/``region`` are Round 3 Wave 2b ADDITIVE, optional
    endpoint overrides (all default None → today's behaviour is byte-identical). They
    let a per-role assignment pin its own endpoint without depending on the bundled
    ``model_registry.json``:

    * ``base_url`` — an OpenAI-compatible / Azure-resource / Bedrock-runtime endpoint
      (vLLM/Ollama/OpenRouter/Together/Groq, or ``https://<resource>.openai.azure.com``).
      When unset the gateway falls back to ``base_url_for(model)`` from the registry,
      then the provider's default endpoint — so existing configs are unaffected.
    * ``api_version`` — the Azure OpenAI ``api-version`` query param for this model.
    * ``region`` — the cloud region (e.g. Bedrock ``us-east-1``).
    """

    provider: Provider = DEFAULT_COMPLETION_PROVIDER
    model: str = DEFAULT_COMPLETION_MODEL
    temperature: float = 0.1
    max_tokens: int = 1500
    base_url: str | None = None
    api_version: str | None = None
    region: str | None = None


class CorrelationRule(BaseModel):
    """Per-rule correlation entry (Section 6.2)."""

    mode: CorrelationMode = CorrelationMode.THRESHOLD
    n: int = Field(default=5, ge=1)
    window_seconds: int = Field(default=120, ge=1)
    group_by: EntityType = EntityType.IP


class RuleMatch(BaseModel):
    """A single field predicate used to classify a raw log into a detection rule.

    ``field`` is a dotted path read with the same tolerant ``dotted_get`` the rest
    of the suite uses (handles nested objects AND flattened keys). Operators:

    * ``equals``  — ``str(value-at-field) == value``
    * ``prefix``  — ``str(value-at-field).startswith(value)``  (e.g. ModSec rule.id "941…")
    * ``tag``     — ``value`` is a member of the field's list/array (e.g. rule.tags)
    * ``exists``  — the field is present and non-empty
    """

    field: str
    op: Literal["equals", "prefix", "tag", "exists"]
    value: str | None = None

    def matches(self, src: dict[str, Any]) -> bool:
        found = dotted_get(src, self.field)
        if self.op == "exists":
            if found is None:
                return False
            if isinstance(found, (list, tuple, set, dict, str)):
                return len(found) > 0
            return True
        if self.op == "tag":
            if self.value is None:
                return False
            if isinstance(found, (list, tuple, set)):
                return self.value in {str(x) for x in found}
            return str(found) == self.value if found is not None else False
        if found is None or self.value is None:
            return False
        if self.op == "equals":
            return str(found) == self.value
        if self.op == "prefix":
            return str(found).startswith(self.value)
        return False


class RuleSchedule(BaseModel):
    """Optional per-detection-rule schedule metadata (G6 R5 "Schedule" tab).

    ADVISORY ONLY — the poller's durable per-feed cursor (``{source.id}:{feed.id}``)
    owns the actual evaluation cadence today; these values persist the operator's
    intent so the editor round-trips losslessly and a future per-rule scheduler can
    honour them. It NEVER feeds ``case_manager.decide()`` (#3). Both fields default
    None (== inherit the feed/global schedule), so an existing stored rule loads
    byte-identically."""

    # Wire keys are snake_case (the FE ``ScheduleForm`` uses camelCase; the rules
    # adapter maps ``intervalSeconds`` ⇄ ``interval_seconds`` etc.).
    interval_seconds: int | None = Field(default=None, ge=1)
    lookback_seconds: int | None = Field(default=None, ge=0)


class RuleSuppression(BaseModel):
    """Optional per-detection-rule alert-storm suppression metadata (G6 R5).

    A DISTINCT concept from the ``correlation`` threshold (Elastic keeps them apart;
    conflating them is a known analyst pitfall). ADVISORY/STORAGE ONLY today — this
    persists the operator's intent so the Suppression editor round-trips; the engine
    does NOT silently DROP events from this per-rule block. Any actual suppression that
    would DROP a candidate stays a HITL Proposal via the existing
    ``Preferences.suppression_rules`` path (#3/#4-safe: never silently drops). All
    fields are defaulted so a stored rule without it loads unchanged."""

    by: list[str] = Field(default_factory=list)              # up-to-3 group-by fields
    scope: Literal["per_run", "per_window"] = "per_run"
    window_seconds: int | None = Field(default=None, ge=1)   # for per_window scope
    missing_field: Literal["suppress", "keep"] = "suppress"  # behaviour on absent field


class RuleDefinition(BaseModel):
    """A config-driven, pre-baked-but-editable detection rule (C3-1).

    Each definition classifies a raw event (via ``match``) into a named rule, can
    carry its own ``correlation`` override and per-role ``model_override`` (C3-6b),
    and is evaluated in ascending ``priority`` (then list order) so ModSec
    sub-rules (lower priority) win over the generic ``modsec_audit_log`` rule.

    ``mitre``/``schedule``/``suppression`` are ADDITIVE, defaulted G6-editor metadata
    (advisory only — none feeds ``decide()``, #3): ``mitre`` is a list of ATT&CK
    technique ids the rule maps to (drives the coverage heatmap), ``schedule`` persists
    an optional per-rule cadence intent, and ``suppression`` persists alert-storm
    collapse intent (never a silent DROP — see :class:`RuleSuppression`)."""

    # ``model_override`` collides with Pydantic's protected ``model_`` namespace;
    # disable the guard (this is plain data, not a Pydantic config attribute).
    model_config = {"protected_namespaces": ()}

    name: str
    enabled: bool = True
    description: str = ""
    match: RuleMatch
    correlation: CorrelationRule | None = None
    model_override: dict[str, ModelConfig] = Field(default_factory=dict)
    priority: int = 100
    # G6 R5 additive editor metadata (advisory; never feeds decide(), #3). All
    # defaulted so a stored rule predating them deserialises byte-identically.
    mitre: list[str] = Field(default_factory=list)           # ATT&CK technique ids
    schedule: RuleSchedule | None = None
    suppression: RuleSuppression | None = None


class RiskWeights(BaseModel):
    """Weights for the deterministic risk score (Section 6.2). Sum need not be 1;
    the scorer normalises to 0-100."""

    volume: float = 0.25
    velocity: float = 0.20
    reputation: float = 0.30
    diversity: float = 0.15
    asset_criticality: float = 0.10


class CapsConfig(BaseModel):
    """Per-case caps / kill switches (Section 6.3 #4)."""

    max_tool_calls: int = 8
    max_tokens: int = 20000
    timeout_seconds: int = 120
    kill_switch: bool = False  # global emergency stop for all investigations
    # Round 4 (additive): the fan-out concurrency ceiling — how many investigations may
    # run in parallel behind the pipeline semaphore. Default 3 preserves a modest
    # bound; a later wave applies it. Advisory to throughput only — never feeds #3.
    max_concurrent: int = Field(default=3, ge=1)
    # Autopilot overhaul (additive): the PER-SOURCE, per-poll-tick ceiling on how many
    # clusters may be auto-forwarded to the strong LLM investigator in one tick. It is
    # enforced inside ``engine.ingest.handle_clusters``, which runs ONCE PER SOURCE (each
    # per-source poller child + each push-ingest batch calls it independently), so this is
    # a PER-SOURCE ceiling — an N-source fan-out permits up to N × this cap auto-
    # investigations in a single tick. It is NOT a global-per-tick knob; the GLOBAL spend
    # bound is ``budget.daily_usd`` (the day-scoped $ backstop the BudgetGate enforces
    # across all sources), which is the real ceiling on total autopilot spend. Once this
    # per-source cap is hit, the source's remaining eligible clusters stay $0 CANDIDATES
    # (never dropped, #4) and drain over later ticks — bounding per-source per-tick spend +
    # the cold-start herd. Default 25 (STANDARDS.md: top of the SANS 20-50 alerts/shift
    # human-throughput band). The ``autopilot_profile`` dial scales it (conservative 10 /
    # balanced 25 / aggressive 100). Never feeds #3.
    max_auto_investigations_per_tick: int = Field(default=25, ge=1)


class FpAutoCloseConfig(BaseModel):
    """DEPRECATED (kept for back-compat with stored configs). Superseded by
    ``AutoClosePolicy.false_positive`` (see below). A ``before`` validator on
    ``Preferences`` migrates a stored ``fp_auto_close`` into ``auto_close`` when the
    latter isn't present, so old persisted preferences keep working.
    """

    enabled: bool = False
    min_confidence: float = 0.95
    max_risk_score: float = 30.0
    objection_window_minutes: int = 60


class VerdictAutoClose(BaseModel):
    """Per-verdict-class auto-close thresholds (operator-tunable).

    Auto-close is a normal calibration surface — like alert thresholds or
    correlation windows. The decision itself is enforced deterministically in
    ``engine/case_manager.decide(...)`` against this data; the LLM verdict feeds the
    policy, it never bypasses it, and a playbook can never change these thresholds.
    """

    enabled: bool = False
    min_confidence: float = Field(default=0.9, ge=0.0, le=1.0)   # verdict confidence must be >=
    max_risk_score: float = Field(default=20.0, ge=0.0, le=100.0)  # cluster risk must be <=
    objection_window_minutes: int = Field(default=1440, ge=0)     # reopen window before true close


class AutoClosePolicy(BaseModel):
    """Operator-configured auto-close policy, one entry per verdict class.

    Conservative defaults: FALSE_POSITIVE may auto-close above a bar; TRUE_POSITIVE
    auto-close is OFF by default (an explicit, supported opt-in); NEEDS_HUMAN never
    auto-closes (enforced in code regardless of this value)."""

    false_positive: VerdictAutoClose = Field(
        default_factory=lambda: VerdictAutoClose(
            enabled=True, min_confidence=0.85, max_risk_score=30.0,
            objection_window_minutes=1440,
        )
    )
    true_positive: VerdictAutoClose = Field(
        default_factory=lambda: VerdictAutoClose(
            enabled=False, min_confidence=0.95, max_risk_score=10.0,
            objection_window_minutes=4320,
        )
    )
    needs_human: VerdictAutoClose = Field(
        default_factory=lambda: VerdictAutoClose(enabled=False)  # never auto-closes (code-enforced)
    )


class PlaybookConfig(BaseModel):
    """Markdown playbook system. When ``enabled``, the deterministically-selected
    playbook for a cluster is injected as TRUSTED operator procedure into the
    investigator (it can only RECOMMEND; code/settings decide). With ``enabled``
    False, or no playbook matching, the investigator uses the generic prompt
    exactly as before. ``dir`` overrides the default ``backend/playbooks`` location;
    ``llm_select`` is reserved for an optional LLM-assisted selector (off by default —
    selection is rule-based)."""

    enabled: bool = True
    dir: str | None = None
    llm_select: bool = False


class CaseIdFormatConfig(BaseModel):
    """Customisable, human-facing case-ID nomenclature (F7).

    ``Case.case_id`` stays the immutable internal id; this drives the OPTIONAL
    ``Case.case_number`` DISPLAY id. Default ``enabled=False`` preserves today's
    behaviour (the UI shows ``case_id``); enabling it renders ``CASE-000001`` etc.
    from ``template`` against an allowlisted placeholder set (validated below).
    ``reset_period`` rolls a fresh sequence at each boundary; ``seq_start`` is the
    first number issued in a bucket."""

    enabled: bool = False
    template: str = "CASE-{seq:06d}"
    prefix: str = "CASE"
    reset_period: Literal["none", "calendar_year", "fiscal_year", "fiscal_quarter"] = "none"
    seq_start: int = 1

    @field_validator("template")
    @classmethod
    def _check_template(cls, v: str) -> str:
        from .engine.case_id import validate_template

        ok, err = validate_template(v)
        if not ok:
            raise ValueError(err)
        return v

    @field_validator("prefix")
    @classmethod
    def _check_prefix(cls, v: str) -> str:
        if len(v) > 40:
            raise ValueError("prefix too long (max 40 characters)")
        return v

    @field_validator("seq_start")
    @classmethod
    def _check_seq_start(cls, v: int) -> int:
        if v < 0:
            raise ValueError("seq_start must be >= 0")
        return v


class CustomizationConfig(BaseModel):
    """ORG-level pervasive-customization defaults (Wave 7, admin-edited).

    This is the ORG side of the two-store customization model: the defaults every
    user inherits unless they override them in their PERSONAL UserPrefs bucket. The
    cascade resolver merges ORG ← USER (a user override always wins). Admin-only via
    the dedicated ``/api/prefs/org`` + ``/api/terminology`` routes (and the settings
    PUT). All free-text is PLAIN DATA rendered by the UI — a terminology label or a
    saved-view name is NEVER interpolated unfenced into an LLM prompt (#9).

    * ``terminology`` — label overrides, e.g. ``{"case": "incident", "cases":
      "incidents"}``. The UI ``t(key)`` helper falls back to the built-in default
      string for any key not present here. Bounded per-key + total size (below).
    * ``default_saved_views`` — org-shared saved views (the operator's curated list
      configurations); a user may clone one into their personal set.
    * ``default_theme`` — the org default colour mode for a user who has not chosen
      their own (a user's ``UserPrefs.theme_mode`` overrides this).
    * ``default_pinned_view_ids`` — org-default pinned (quick-access) saved-view ids.
    * ``default_dashboards`` — org/role default custom-dashboard layouts (Round 5 / G7),
      keyed by role (or ``"default"``). Each value is a ``DashboardLayout`` serialised as
      a plain dict (kept loose here to avoid a config→models import cycle — the same
      pattern ``default_saved_views`` uses). The FE clone-to-customize flow copies the
      caller's role default into their PERSONAL set on first edit. A dashboard layout is
      ADVISORY presentation state only — it never feeds ``case_manager.decide()`` (#3),
      and every dashboard/widget ``name``/``title`` is PLAIN data the UI render-escapes
      (#9), never interpolated unfenced into a prompt.
    """

    model_config = {"protected_namespaces": ()}

    terminology: dict[str, str] = Field(default_factory=dict)
    default_saved_views: list[dict[str, Any]] = Field(default_factory=list)
    default_theme: Literal["light", "dark", "system"] = "system"
    default_pinned_view_ids: list[str] = Field(default_factory=list)
    # Role → default DashboardLayout (serialised as a plain dict; validated into a real
    # DashboardLayout at the API boundary, never here — avoids the config→models cycle).
    default_dashboards: dict[str, dict[str, Any]] = Field(default_factory=dict)

    # Caps so the config doc stays small + a terminology label can't smuggle a huge
    # blob (it is plain data, but still bounded — #9/#10 discipline).
    _MAX_TERM_KEYS: ClassVar[int] = 200
    _MAX_TERM_LEN: ClassVar[int] = 120
    _MAX_DEFAULT_DASHBOARDS: ClassVar[int] = 32

    @field_validator("default_dashboards")
    @classmethod
    def _bound_default_dashboards(
        cls, v: dict[str, dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        """Backstop the org-default dashboard map so a config doc stays small (the API
        layer allowlist-validates the widget shape; this only bounds cardinality)."""
        if not v:
            return {}
        if len(v) > cls._MAX_DEFAULT_DASHBOARDS:
            raise ValueError(
                f"too many default dashboards (max {cls._MAX_DEFAULT_DASHBOARDS})"
            )
        return v

    @field_validator("terminology")
    @classmethod
    def _check_terminology(cls, v: dict[str, str]) -> dict[str, str]:
        if not v:
            return {}
        if len(v) > 200:
            raise ValueError("too many terminology overrides (max 200)")
        out: dict[str, str] = {}
        for key, val in v.items():
            k = str(key).strip()
            sval = str(val)
            if not k:
                continue
            if len(k) > 120 or len(sval) > 120:
                raise ValueError("terminology key/value too long (max 120 characters)")
            out[k] = sval
        return out


class BrandingConfig(BaseModel):
    """Operator-customisable branding/appearance (UI-editable, persisted).

    Powers the org logo + name + accent colour + theme shown across the console
    shell (and the login screen). The logo is stored as a small base64 data URL
    (bounded) so it round-trips through the config store with no asset hosting.
    Non-secret; readable pre-auth so the login screen can show the org's brand."""

    model_config = {"protected_namespaces": ()}

    # Temporary shipped product identity. Technical compatibility names (TLSOC_*
    # environment variables, index prefixes and API namespaces) intentionally stay
    # unchanged; this is the operator-facing brand only.
    org_name: str = "Agentic SOC"
    product_name: str = ""
    logo_data_url: str = ""           # "data:image/png;base64,...." (bounded), or ""
    favicon_data_url: str = ""        # browser-tab icon as a data:image/* URL (bounded), or ""
    accent_color: str = ""            # "#RRGGBB" override for the UI accent, or "" = default
    accent_color2: str = ""           # "#RRGGBB" secondary gradient stop, or "" = default
    theme: Literal["dark", "light", "system"] = "dark"
    # New (all additive, optional, defaulted → back-compatible with older docs):
    login_subtitle: str = ""          # welcome line under the login wordmark, or ""
    footer_text: str = ""             # footer / classification banner line, or ""
    support_url: str = ""             # "Docs & help" / support link target (http/https), or ""
    dark_mode_default: bool = False   # default colour mode for new sessions (no stored pref)
    # --- Round 3 theming (all ADDITIVE + defaulted → older docs load unchanged). ---
    # ``material`` selects the shell density/contrast surface (quiet | command). It is
    # a :class:`app.constants.Material` value carried as a plain str.
    material: Literal["quiet", "command"] = "quiet"
    # ``default_theme`` SUPERSEDES/aliases the legacy ``theme`` + ``dark_mode_default``
    # for new code: it is the org default colour mode a user inherits (a user's
    # ``UserPrefs.theme_mode`` overrides it). The legacy fields are KEPT working — see
    # ``effective_theme()`` / ``effective_dark_default()`` below for the reconciliation.
    default_theme: Literal["dark", "light", "system"] = "dark"
    # ``theme_tokens`` is a small, BOUNDED design-token override map (css-var name →
    # value, e.g. {"--accent": "#3b82f6"}) a later wave applies as runtime CSS vars.
    # Plain data; bounded by the validator below (#9/#10 discipline).
    theme_tokens: dict[str, str] = Field(default_factory=dict)
    # ``presets`` is an operator-curated list of named theme presets the UI offers
    # (each ``{name, material?, default_theme?, theme_tokens?, ...}``), plain data.
    presets: list[dict[str, Any]] = Field(default_factory=list)
    # --- Round 4 login white-label (ALL additive + defaulted → older docs load
    # unchanged). These are BOUNDED PLAIN-TEXT ONLY (NO raw HTML/SVG): the UI renders
    # them as text, and the validator below REJECTS any '<' so no markup can smuggle in
    # (#9). ``login_headline``/``login_body`` are the hero copy; ``login_chips`` are a
    # few short feature bullets; ``login_layout`` picks a login arrangement; and
    # ``login_illustration`` is a KEY from a small curated set (validated), never a URL
    # or inline asset. ---
    login_headline: str = ""          # login hero headline (plain text, bounded)
    login_body: str = ""              # login hero body copy (plain text, bounded)
    login_chips: list[str] = Field(default_factory=list)  # short feature bullets (plain text)
    login_layout: Literal["split", "centered", "full"] = "split"
    login_illustration: str = ""      # a key from _LOGIN_ILLUSTRATIONS ("" = none/default)
    # Max accepted logo/favicon data-URL length (~1MB image). Keeps the config doc small.
    _MAX_LOGO_LEN: int = 1_400_000
    # Caps for the free-text branding strings (rendered as plain text; bound prefs size).
    _MAX_TEXT_LEN: int = 400
    _MAX_URL_LEN: int = 2_000
    # Caps for the theme-token override map (plain data, but bounded — #9/#10).
    _MAX_THEME_TOKENS: ClassVar[int] = 200
    _MAX_THEME_TOKEN_LEN: ClassVar[int] = 200
    # Round-5 W0-A A7 — the server-side MIRROR of the webui allow-list
    # (theme-tokens.ts ALLOWED_TOKENS). Only these `--*` custom properties are
    # persistable; any other key is DROPPED (silently, not raised) so a legacy doc
    # never fails validation but a disallowed/derived token can never be smuggled in.
    # The derived AA companions (`*-foreground`/`*-text`) are deliberately ABSENT so
    # an operator can never break the measured contrast pairing. Keep this in lockstep
    # with theme-tokens.ts ALLOWED_TOKENS.
    _ALLOWED_THEME_TOKENS: ClassVar[frozenset[str]] = frozenset({
        # Core brand + ring
        "--primary", "--ring", "--accent2",
        # Semantic SOC fills are intentionally absent. Each fill is coupled to a
        # measured foreground/text/CVD axis; accepting only the fill lets an org-wide
        # branding payload invalidate every badge, chart and status treatment.
        # Canvas / surface tints (backdrop nudges)
        "--canvas-tint", "--surface-tint",
        # Radius + density scale
        "--radius", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--density-unit",
        # Display font hook (value further restricted below)
        "--font-display",
        # Material-pack chrome
        "--glass-tint", "--glass-opacity", "--glow-strength", "--grid-opacity",
    })
    # The vetted display-font values (mirror theme-tokens.ts FONT_ALLOWLIST outputs).
    _FONT_ALLOWLIST: ClassVar[dict[str, str]] = {
        "inter": "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        "system": "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        "mono": "'JetBrains Mono', SFMono-Regular, Consolas, Menlo, monospace",
        "grotesk": "'Space Grotesk', 'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif",
    }
    _FONT_LEGACY_ALIASES: ClassVar[dict[str, str]] = {
        "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif": "inter",
        "'Space Grotesk', Inter, ui-sans-serif, system-ui, sans-serif": "grotesk",
    }
    # Caps for the Round-4 login white-label copy (plain text, bounded — #9/#10).
    _MAX_LOGIN_HEADLINE_LEN: ClassVar[int] = 120
    _MAX_LOGIN_BODY_LEN: ClassVar[int] = 600
    _MAX_LOGIN_CHIPS: ClassVar[int] = 6
    _MAX_LOGIN_CHIP_LEN: ClassVar[int] = 60
    # The curated set of built-in login-illustration keys (validated). "" == none.
    _LOGIN_ILLUSTRATIONS: ClassVar[tuple[str, ...]] = (
        "", "shield", "radar", "grid", "waves", "aurora", "constellation", "mesh",
    )

    def effective_theme(self) -> str:
        """The org default colour mode, reconciling new + legacy fields. Prefers the
        explicit ``default_theme`` when set to a non-default value, else honours the
        legacy ``dark_mode_default`` / ``theme``. Pure read-only helper (no mutation),
        so adding it can never change a stored value."""
        # ``default_theme`` defaults to "dark"; only treat it as authoritative when the
        # legacy signals don't disagree. Legacy ``dark_mode_default=True`` forces dark.
        if self.dark_mode_default:
            return "dark"
        return self.default_theme or self.theme

    @classmethod
    def _sanitize_token_value(cls, name: str, value: str) -> str | None:
        """Mirror of theme-tokens.ts ``sanitizeTokenValue`` (#9/#10). Rejects any
        value that could escape a single CSS declaration (braces/semicolons/`url(`/
        `expression(`/comment markers/angle-brackets/backslashes/`@`, or > cap length),
        returning None when unsafe. ``--font-display`` is restricted to the vetted
        font enum (key OR a known full stack). Bare HSL/hex/rem values all pass.
        Defence-in-depth: the client never applies a value this rejects, so persisting
        it would be dead + risky."""
        v = value.strip()
        if not v or len(v) > cls._MAX_THEME_TOKEN_LEN:
            return None
        if re.search(r"[{}<>\\;@]", v):
            return None
        if re.search(r"url\s*\(", v, re.IGNORECASE):
            return None
        if re.search(r"expression\s*\(", v, re.IGNORECASE):
            return None
        if "/*" in v or "*/" in v:
            return None
        if name == "--font-display":
            key = v.lower()
            if key in cls._FONT_ALLOWLIST:
                # Keep the stable enum on the wire. The browser expands it to the
                # matching self-hosted stack at the DOM boundary; returning a full
                # stack here made the Settings Select lose its value after reload.
                return key
            for known_key, stack in cls._FONT_ALLOWLIST.items():
                if v == stack:
                    # Canonicalise already-saved full stacks compatibly.
                    return known_key
            if v in cls._FONT_LEGACY_ALIASES:
                return cls._FONT_LEGACY_ALIASES[v]
            return None
        return v

    @field_validator("theme_tokens")
    @classmethod
    def _check_theme_tokens(cls, v: dict[str, str]) -> dict[str, str]:
        # Round-5 W0-A A7: allow-list + sanitize server-side, mirroring the webui
        # (theme-tokens.ts). Unknown keys + unsafe values are DROPPED (not raised) so
        # a legacy doc always loads; gross abuse (too many / over-long) still raises,
        # preserving the prior behaviour. The webui already ignores anything this drops.
        if not v:
            return {}
        if len(v) > cls._MAX_THEME_TOKENS:
            raise ValueError("too many theme tokens (max 200)")
        out: dict[str, str] = {}
        for key, val in v.items():
            k = str(key).strip()
            if not k:
                continue
            k = k if k.startswith("--") else f"--{k}"
            sval = str(val)
            if len(k) > cls._MAX_THEME_TOKEN_LEN or len(sval) > cls._MAX_THEME_TOKEN_LEN:
                raise ValueError("theme token key/value too long (max 200 characters)")
            if k not in cls._ALLOWED_THEME_TOKENS:
                continue  # drop non-allow-listed / derived (*-foreground/*-text) tokens
            safe = cls._sanitize_token_value(k, sval)
            if safe is None:
                continue  # drop unsafe value
            out[k] = safe
        return out

    @field_validator("logo_data_url", "favicon_data_url")
    @classmethod
    def _check_logo(cls, v: str) -> str:
        if not v:
            return v
        if not v.startswith("data:image/"):
            raise ValueError("image must be an empty string or a data:image/* URL")
        if len(v) > 1_400_000:
            raise ValueError("image too large (max ~1MB)")
        # Reject SVG (it can carry script) — mirror the avatar validator's SVG-reject
        # for defense-in-depth, even though the logo/favicon render via <img src>/
        # <link href> (not dangerouslySetInnerHTML). `data:image/svg+xml` AND a bare
        # `data:image/svg` are both refused (#9/#10).
        head = v[:64].lower()
        if head.startswith("data:image/svg"):
            raise ValueError("SVG images are not allowed (they can embed script)")
        # Defense-in-depth magic-sniff for the common base64 raster types: a declared
        # png/jpeg/webp/gif data-URL whose decoded body does not start with the
        # matching magic is rejected (e.g. SVG/markup smuggled under a raster mime).
        # Non-base64 data-URLs and unrecognised image subtypes are left to the prefix
        # + SVG checks above (back-compat — never tightens an already-stored raster).
        import binascii
        import base64

        m = re.match(r"^data:image/(png|jpeg|jpg|webp|gif);base64,(.+)$", v, re.DOTALL)
        if m:
            kind, body = m.group(1), m.group(2)
            try:
                raw = base64.b64decode(body, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("image base64 body is malformed") from exc
            magic = {
                "png": (b"\x89PNG\r\n\x1a\n",),
                "jpeg": (b"\xff\xd8\xff",),
                "jpg": (b"\xff\xd8\xff",),
                "gif": (b"GIF87a", b"GIF89a"),
            }
            if kind == "webp":
                if not (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
                    raise ValueError("image is not a valid webp")
            elif not any(raw.startswith(p) for p in magic[kind]):
                raise ValueError(f"image is not a valid {kind}")
        return v

    @field_validator("accent_color", "accent_color2")
    @classmethod
    def _check_accent(cls, v: str) -> str:
        if not v:
            return v
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
            raise ValueError("accent colour must be a #RRGGBB hex string or empty")
        return v

    @field_validator("login_subtitle", "footer_text")
    @classmethod
    def _check_text(cls, v: str) -> str:
        if v and len(v) > 400:
            raise ValueError("branding text too long (max 400 characters)")
        return v

    @field_validator("support_url")
    @classmethod
    def _check_support_url(cls, v: str) -> str:
        if not v:
            return v
        if len(v) > 2_000:
            raise ValueError("support_url too long")
        if not re.match(r"^https?://", v):
            raise ValueError("support_url must be an empty string or an http(s) URL")
        return v

    @field_validator("login_headline")
    @classmethod
    def _check_login_headline(cls, v: str) -> str:
        # Plain text only — reject any markup (#9). Bounded length.
        if "<" in v:
            raise ValueError("login_headline must be plain text (no markup / '<')")
        if len(v) > 120:
            raise ValueError("login_headline too long (max 120 characters)")
        return v

    @field_validator("login_body")
    @classmethod
    def _check_login_body(cls, v: str) -> str:
        if "<" in v:
            raise ValueError("login_body must be plain text (no markup / '<')")
        if len(v) > 600:
            raise ValueError("login_body too long (max 600 characters)")
        return v

    @field_validator("login_chips")
    @classmethod
    def _check_login_chips(cls, v: list[str]) -> list[str]:
        if not v:
            return []
        if len(v) > 6:
            raise ValueError("too many login chips (max 6)")
        out: list[str] = []
        for chip in v:
            s = str(chip)
            if "<" in s:
                raise ValueError("login chip must be plain text (no markup / '<')")
            if len(s) > 60:
                raise ValueError("login chip too long (max 60 characters)")
            out.append(s)
        return out

    @field_validator("login_illustration")
    @classmethod
    def _check_login_illustration(cls, v: str) -> str:
        # A KEY from the small curated set only — never a URL / inline asset (#9).
        allowed = ("", "shield", "radar", "grid", "waves", "aurora", "constellation", "mesh")
        if v not in allowed:
            raise ValueError(f"login_illustration must be one of {allowed}")
        return v


class EnrichmentConfig(BaseModel):
    enabled: bool = True
    use_abuseipdb: bool = True
    use_virustotal: bool = True
    use_geoip: bool = True
    cache_ttl_seconds: int = 21600  # 6h — protects tight free-tier limits
    # --- Round 3 multi-provider threat-intel (ALL additive + defaulted). Each toggle
    # enables one enrichment provider; the per-provider API keys live in the SECRET
    # tier (``Secrets``). Defaults are chosen so the suite is USABLE WITH NO NEW KEYS:
    # the KEYLESS providers (shodan_internetdb / ipinfo lite / urlhaus / threatfox /
    # malwarebazaar / rdap) default ON; every key-gated provider defaults OFF (the
    # operator opts in after configuring its key). A later wave wires the actual
    # provider clients + the fusion scorer; here these only CARRY the policy. ---
    use_greynoise: bool = False
    use_shodan_internetdb: bool = True     # keyless (InternetDB)
    use_shodan: bool = False
    use_censys: bool = False
    use_binaryedge: bool = False
    use_ipinfo: bool = True                # keyless lite
    use_otx: bool = False
    use_pulsedive: bool = False
    use_spur: bool = False
    use_xforce: bool = False
    use_urlhaus: bool = True               # keyless
    use_threatfox: bool = True             # keyless
    use_malwarebazaar: bool = True         # keyless
    use_urlscan: bool = False
    use_hibp: bool = False
    use_rdap: bool = True                  # keyless
    # Project Honeypot http:BL (key-gated; needs ``Secrets.honeypot_access_key``).
    # Default OFF — the operator opts in after configuring the access key.
    use_honeypot: bool = False
    # --- Round 11 enrichment expansion (ALL additive + defaulted; each toggle
    # enables one provider; keys live in ``Secrets``). Keyless + quota-safe ones
    # default ON; keyless-but-caveated ones (Spamhaus/Cymru need the host's OWN
    # resolver — public resolvers are refused; Robtex/crt.sh can be slow) default
    # OFF; every key-gated provider defaults OFF. ---
    use_circl_hashlookup: bool = True      # keyless (known-good hash lookup)
    use_dshield: bool = True               # keyless (SANS ISC sensor sightings)
    use_onionoo: bool = True               # keyless (Tor relay/exit context)
    use_spamhaus: bool = False             # keyless DNSBL; needs own resolver
    use_cymru_mhr: bool = False            # keyless DNS hash lookup; needs own resolver
    use_robtex: bool = False               # keyless passive-DNS context (slow free tier)
    use_crt_sh: bool = False               # keyless cert-transparency context (slow)
    use_crowdsec: bool = False
    use_google_safebrowsing: bool = False
    use_ipqualityscore: bool = False
    use_ipdata: bool = False
    use_apivoid: bool = False
    use_maltiverse: bool = False
    use_securitytrails: bool = False
    use_criminalip: bool = False
    use_netlas: bool = False
    use_hybrid_analysis: bool = False
    use_metadefender: bool = False
    use_emailrep: bool = False
    # When True, a later wave FUSES the per-provider results into one normalised
    # reputation score (instead of using each provider in isolation). Default OFF.
    fusion_enabled: bool = False


class UnconfirmedPrecedentConfig(BaseModel):
    """Compounding guards for the LOWER-TRUST ``model_unconfirmed`` precedent tier.

    A fully autonomous deployment can never satisfy the analyst-confirmed gate
    (``engine/analyst_outcomes.analyst_confirmed_outcome``): auto-close depends on
    precedent, precedent depends on analyst labels, and analyst labels only exist if
    somebody works a queue the product exists to keep empty.  The escape hatch is a
    SEPARATE, explicitly weaker tier — the agent's own unreviewed closes, labelled as
    such — NOT a loosening of that gate.

    The failure mode this block exists to prevent is the agent's own drift being fed
    back to it as evidence.  No single guard is sufficient, so four independent ones
    compose (every one is individually disable-able, and all of them are inert while
    ``RagConfig.use_unconfirmed_resolved_cases`` is False):

    * ``min_confidence`` — a low-confidence auto-close is exactly the judgement most
      likely to be wrong, and it is the cheapest thing to exclude.  High confidence is
      not accuracy, so this is a floor, never a warrant.
    * ``min_recurrence`` — one auto-close is an anecdote; the same (entity-type, rule
      set, outcome) pattern closed the same way N times is at least a stable, auditable
      regularity.  This is what stops ONE hallucinated close from becoming quotable
      precedent.  Recurrence is counted inside the bounded scan window only.
    * ``max_age_days`` — unconfirmed precedent is a PROVISIONAL belief that decays.  If
      it mattered, an analyst should have confirmed it by now (at which point it is
      promoted to the confirmed tier, which never ages out); if nobody did, the
      environment has probably moved on.  Enforced both at projection and at retrieval,
      so a chunk already in the vector store also goes quiet on schedule.
    * ``max_context_share`` — a hard cap on the FRACTION of a retrieval that may be the
      model's own prior output, so a run can never be dominated by an echo of itself.

    ``rank_penalty`` additionally demotes unconfirmed chunks in the blended ranking, and
    ``max_items`` bounds how much unconfirmed precedent the projection may hold at all.

    None of this touches the deterministic close/escalate decision (#3): precedent is
    retrieved context for the investigator, and it stays UNTRUSTED-fenced (#9).
    """

    # Minimum MODEL confidence on the auto-closed case before it may be precedent.
    min_confidence: float = Field(default=0.8, ge=0.0, le=1.0)
    # How many times the same (entity_type, rule set, outcome) pattern must have been
    # auto-closed the same way before ANY of them is indexed. 1 disables the guard.
    min_recurrence: int = Field(default=3, ge=1, le=1000)
    # Age-out horizon, in days, applied to the case's terminal timestamp.
    max_age_days: int = Field(default=30, ge=1, le=3650)
    # Upper bound on the FRACTION of one retrieval that may be unconfirmed precedent.
    # The effective cap is floor(top_k * max_context_share); 0.0 blocks it entirely.
    max_context_share: float = Field(default=0.34, ge=0.0, le=1.0)
    # Multiplier applied to an unconfirmed chunk's final ranking score. Confirmed
    # precedent additionally OUTRANKS unconfirmed unconditionally (tier invariant).
    rank_penalty: float = Field(default=0.5, ge=0.0, le=1.0)
    # Bound on how many unconfirmed precedents the projection may hold.
    max_items: int = Field(default=50, ge=0, le=1000)


class RagConfig(BaseModel):
    enabled: bool = True
    top_k: int = 4
    # Minimum cosine similarity a retrieved chunk must clear to be returned.
    # Drops weakly-related noise before it reaches a prompt.
    min_score: float = 0.2
    use_runbooks: bool = True
    use_mitre: bool = True
    use_resolved_cases: bool = True
    use_suppression_rules: bool = True
    # Hybrid retrieval (MemPalace-inspired "drawer-floor-first"): the vector search
    # is the floor; survivors that clear ``min_score`` are re-ranked by a convex
    # blend of vector similarity and a dependency-free BM25 lexical score, which
    # sharply improves recall on IOC/log/rule text that embeds as noise. ``min_score``
    # still gates on the raw vector score, so disabling hybrid is exact prior behaviour.
    hybrid: bool = True
    vector_weight: float = 0.6
    bm25_weight: float = 0.4
    hybrid_overfetch: int = 4  # candidate pool = top_k * this, before re-rank
    # Reusable-knowledge loop (Wave 6 / F11): include imported threat-intel documents
    # (source="threat_context") in retrieval so they are injected as a TRUSTED fenced
    # block. ``use_resolved_cases`` (above) controls past-case institutional memory.
    use_threat_context: bool = True
    # --- The LOWER-TRUST precedent tier (default OFF, #10). -------------------------
    # ``use_resolved_cases`` indexes ONLY analyst-confirmed ground truth. A fully
    # autonomous deployment produces none of that, so its precedent corpus is
    # permanently empty. Turning this ON additionally indexes the agent's own
    # auto-closed cases as a DISTINCT ``trust_class="model_unconfirmed"`` tier: never
    # promoted to analyst-confirmed, always outranked by it, bounded by the
    # ``unconfirmed_precedent`` guards below, rendered under a SEPARATE prompt heading
    # that does not claim analyst provenance, and still UNTRUSTED-fenced (#9).
    #
    # Default FALSE so an existing deployment's retrieval is byte-identical (#10). It
    # requires ``use_resolved_cases`` as well — it is a sub-tier of the precedent
    # corpus, not an independent source. It NEVER loosens
    # ``analyst_confirmed_outcome``: the threshold tuner and every other
    # independent-ground-truth consumer see exactly what they saw before.
    use_unconfirmed_resolved_cases: bool = False
    unconfirmed_precedent: UnconfirmedPrecedentConfig = Field(
        default_factory=UnconfirmedPrecedentConfig
    )
    # --- Projection collapse guard -------------------------------------------------
    # The smallest fraction of the PREVIOUS corpus a freshly built projection may hold
    # before the rebuild is treated as FAILED and refused. A projection that shrinks
    # dramatically is not a smaller corpus, it is a broken build: the source of truth
    # is unchanged, so the only thing that can have shrunk is our ability to read or
    # embed it. Refusing keeps the last known-good corpus instead of replacing it with
    # a fraction of itself (or with nothing — a projection reaching ZERO is refused
    # unconditionally, independent of this ratio).
    #
    # 0.5 means "a rebuild may never silently lose half the corpus". Set to 0.0 to
    # disable the ratio guard entirely; the zero-projection guard is NOT tunable, on
    # purpose — an empty corpus is never a legitimate rebuild of a non-empty one.
    #
    # Advisory to projection VALIDATION only. It is never read by
    # ``case_manager.decide()`` (#3) and never changes WHAT is projected — so it is
    # deliberately absent from ``RagService._source_signature()``, where it would
    # force a full (billable) re-embed on every threshold tweak.
    min_projection_retention: float = Field(default=0.5, ge=0.0, le=1.0)


class PersonaConfig(BaseModel):
    """Multi-agent investigator roster (Vigil-inspired). When ``enabled`` the
    cluster is routed to a specialized persona (identity/web/recon/malware/threat-
    intel) deterministically; the generalist is used otherwise. ``overrides`` pins
    a specific persona id for a given rule name (operator control). Disabling this
    reverts to the single generalist investigator — byte-for-byte the old behaviour
    aside from the (empty) persona addendum."""

    enabled: bool = True
    overrides: dict[str, str] = Field(default_factory=dict)  # rule name -> persona id


class RunbookConfig(BaseModel):
    """Plain-text runbook KNOWLEDGE for the RAG corpus.

    Runbooks ship as Markdown files under ``backend/app/runbooks/`` and feed the RAG
    ``runbook`` corpus (retrievable knowledge) when ``rag.use_runbooks`` is on and
    ``enabled`` here. NOTE: per-cluster PROCEDURE injection is now owned by the
    Markdown **playbook** system (``app/playbooks/`` + ``PlaybookConfig``); runbooks
    are retrieval knowledge only. Disabling is exact: no runbook source is indexed
    or retrieved until the operator enables it again."""

    enabled: bool = True


class ThreatContextConfig(BaseModel):
    """Threat-context case panel (Wave 6 / F11).

    Assembles a read-only, fail-open context object for a case (IOC reputation,
    MITRE techniques, related cases, asset context, evidence). All ADVISORY — it
    never touches the deterministic decision. ``mitre_enabled`` toggles the bundled
    MITRE technique lookup; ``reuse_resolved_cases`` toggles surfacing prior
    resolved cases as related context; ``ioc_malicious_threshold`` is the 0..100
    reputation score at/above which an IOC is shown as malicious in the panel."""

    enabled: bool = True
    mitre_enabled: bool = True
    reuse_resolved_cases: bool = True
    ioc_malicious_threshold: int = Field(default=50, ge=0, le=100)


class CaseAutomationRule(BaseModel):
    """One post-decision threshold-automation rule (Wave 6 / F10).

    RENAMED in Round 4 from ``AutomationRule`` → ``CaseAutomationRule`` to free the
    ``AutomationRule`` name for a future unified rule shape; a module-level
    ``AutomationRule = CaseAutomationRule`` alias (below ``ThresholdAutomationConfig``)
    keeps every existing import + the stored ``threshold_automation`` config
    round-tripping BYTE-IDENTICALLY (the wire key and ALL field names are unchanged).

    Evaluated AFTER the deterministic ``case_manager.decide()`` + save. A rule
    MATCHES a case when ALL of its present (non-empty) ``conditions`` hold, and
    fires its single ``action``. The action is ADVISORY/SAFE
    (``tag``/``recommend``/``notify``/``run_playbook``) — applied directly + audited
    — OR ``request_approval``, which creates a HITL ``Proposal`` (the existing
    proposer/approve path is the only live-write route). It can NEVER set
    ``case.status``/``disposition`` (#3). ``priority`` orders evaluation (lower =
    earlier); ``conditions`` keys are matched leniently (an absent key never
    constrains). ``payload`` carries action-specific data (e.g. the tag text, the
    recommendation, the channel id, the ``playbook_id`` to run)."""

    id: str
    # Optional operator-facing DISPLAY name, independent of the (immutable) ``id`` so a
    # rule can be renamed after creation (G6 R5, #F25). ADDITIVE + defaulted "" → a
    # stored rule predating it deserialises byte-identically and the UI falls back to
    # ``id`` when blank. Plain, attacker-uninfluenced operator text → rendered escaped
    # (#9); it never feeds the matcher or ``decide()`` (#3).
    name: str = ""
    enabled: bool = True
    priority: int = 100
    # Conditions (all-of; an absent/empty key does not constrain):
    #   verdict (FALSE_POSITIVE|TRUE_POSITIVE|NEEDS_HUMAN), min_risk (0..100),
    #   min_severity (0..100, the case risk_score), status (a CaseStatus value),
    #   source_id, rule_name (matched against the case's rule_ids), entity_type.
    conditions: dict[str, Any] = Field(default_factory=dict)
    action: Literal["tag", "recommend", "notify", "run_playbook", "request_approval"] = "tag"
    payload: dict[str, Any] = Field(default_factory=dict)


class ThresholdAutomationConfig(BaseModel):
    """Threshold-automation policy (Wave 6 / F10). The ENGINE defaults ON (Autopilot
    overhaul) but ``rules`` defaults EMPTY, so out of the box it is a byte-identical
    NO-OP (``evaluate`` returns ``[]`` with no rule to match) — enabling the engine is
    free and costs nothing until an operator ships a rule. When ``enabled`` and a rule
    matches, it is evaluated (priority order) AFTER the deterministic decision + save
    and may TAG / RECOMMEND / NOTIFY / QUEUE a playbook re-investigation / request HITL
    approval — NEVER set the case status or close a case (#3). We ship NO default
    cost-bearing rules: ``run_playbook``/``notify`` rules stay an explicit opt-in."""

    enabled: bool = True
    rules: list[CaseAutomationRule] = Field(default_factory=list)


# Back-compat alias: the class was renamed ``AutomationRule`` → ``CaseAutomationRule``
# in Round 4 (freeing the ``AutomationRule`` name for a future unified rule). Every
# existing import (``from app.config import AutomationRule``) + the approve/reject
# branch in ``api/routes.py`` + the stored ``threshold_automation`` config keep working
# UNCHANGED through this alias — the wire key and all field names are byte-identical.
AutomationRule = CaseAutomationRule


class TraceConfig(BaseModel):
    """Agent-pipeline trace surfacing (C3-3). ``include_prompts`` lets an operator
    hide raw prompt excerpts (which carry fenced untrusted log data) from the
    case-detail trace timeline."""

    include_prompts: bool = True


# --------------------------------------------------------------------------- #
# Round 3 — SLA / priority / budget / realtime config blocks. ALL additive +
# defaulted so an existing stored config loads unchanged. ⚠ NON-NEGOTIABLE #3:
# NONE of these feeds ``engine/case_manager.decide()`` — they drive PRESENTATION,
# REPORTING, COST-GOVERNANCE and live-update plumbing only; the deterministic close/
# escalate decision stays a pure fn of verdict/confidence/risk_score/policy.
# --------------------------------------------------------------------------- #
class SlaTarget(BaseModel):
    """One SLA tier's response + resolution time targets (minutes). Advisory only —
    used to surface "at risk / breached" badges + MTTR reporting, never to gate the
    deterministic decision (#3)."""

    response_minutes: int = Field(default=60, ge=0)
    resolve_minutes: int = Field(default=1440, ge=0)


class SlaPolicy(BaseModel):
    """Per-priority SLA response/resolution targets (Round 3). Defaults ON (Autopilot
    overhaul) — pure advisory badges/reporting from sane, descending P1..P4 targets, so
    every tenant gets SLA aging + attainment out of the box. ADVISORY: SLA timers/badges
    are presentation; they never touch ``decide()`` (#3). The at-risk/breached state is
    derived from a case's lifecycle timestamps
    (``detected_at``/``acknowledged_at``/``first_response_at``) against these targets."""

    enabled: bool = True
    targets: dict[str, SlaTarget] = Field(
        default_factory=lambda: {
            "P1": SlaTarget(response_minutes=15, resolve_minutes=240),
            "P2": SlaTarget(response_minutes=30, resolve_minutes=480),
            "P3": SlaTarget(response_minutes=120, resolve_minutes=1440),
            "P4": SlaTarget(response_minutes=480, resolve_minutes=4320),
        }
    )
    # Optional business-hours window for SLA clocks (a later wave may honour it). When
    # ``business_hours_only`` is False the clock runs 24x7 (the default).
    business_hours_only: bool = False
    timezone: str = "UTC"


class PriorityMatrix(BaseModel):
    """Impact × Urgency → Priority (P1..P4) mapping (Round 3, ITIL-style). Default is
    the standard ITIL 3×3 grid. ADVISORY: a later wave derives ``Case.priority_level``
    from ``impact_band`` × ``urgency_band`` via this matrix; it NEVER changes the
    verdict or the deterministic decision (#3). ``levels`` lists the band labels (high
    → low) so the UI can render the grid; ``matrix`` maps ``"{impact}/{urgency}"`` →
    a P-level, with ``default_priority`` as the fallback for any unmapped pair.

    Defaults ON (Autopilot overhaul): the standard ITIL grid is a good OOTB default and
    pairs with :class:`SlaPolicy` (SLA tiers key off the P-level). Advisory only (#3)."""

    enabled: bool = True
    levels: list[str] = Field(default_factory=lambda: ["high", "medium", "low"])
    default_priority: str = "P3"
    matrix: dict[str, str] = Field(
        default_factory=lambda: {
            "high/high": "P1", "high/medium": "P2", "high/low": "P3",
            "medium/high": "P2", "medium/medium": "P3", "medium/low": "P4",
            "low/high": "P3", "low/medium": "P4", "low/low": "P4",
        }
    )


class BudgetConfig(BaseModel):
    """LLM cost-budget ceiling (Round 3 cost governance). When ``enabled`` the gate
    compares rolling
    spend (from the existing usage/cost ledger) against ``daily_usd``/``monthly_usd``;
    at ``soft_warn_pct`` of a ceiling it WARNS, and ``on_exceed`` decides whether
    crossing a ceiling merely warns or BLOCKS further LLM spend. NOTE: a budget block
    affects whether an investigation RUNS — it never alters the close/escalate decision
    of a case that DID run (#3).

    Defaults ON as the Autopilot spend BACKSTOP: ``enabled=True`` + a bounded
    ``daily_usd=10`` (industry-grounded balanced default; ~20-40 Opus investigations —
    see ``STANDARDS.md``) + ``soft_warn_pct=0.8`` + **``on_exceed='block'``**. A block
    happens before the provider call and routes the case to NEEDS_HUMAN; it never closes
    or discards the case (#3/#4). This is the backstop that keeps "read everything by
    default" from becoming "spend everything." An operator can raise ``daily_usd``,
    disable it, or explicitly choose warning-only mode. The ``autopilot_profile`` dial scales
    ``daily_usd`` (conservative $5 / balanced $10 / aggressive $50)."""

    enabled: bool = True
    daily_usd: float | None = 10.0
    monthly_usd: float | None = None
    soft_warn_pct: float = Field(default=0.8, ge=0.0, le=1.0)
    on_exceed: Literal["warn", "block"] = "block"


class RealtimeConfig(BaseModel):
    """Live-update (SSE/websocket) plumbing config (Round 3). Defaults ON (Autopilot
    overhaul) — pure transport, the webui already falls back to polling, so ON simply
    upgrades responsiveness (and pairs with the motion layer). ``heartbeat_seconds`` is
    the keep-alive cadence for a live stream. No decision impact (#3)."""

    enabled: bool = True
    heartbeat_seconds: int = Field(default=15, ge=1)


_GITHUB_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
_GITHUB_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$")
_GITHUB_BRANCH_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$")


def _canonical_public_github_repository(value: str) -> str:
    """Validate and canonicalise one public GitHub repository URL.

    Release discovery deliberately accepts no arbitrary host, port, credentials,
    query string or fragment.  The resulting owner/repository coordinates are used
    only with the fixed ``api.github.com`` API origin by the discovery service, so a
    saved preference can never become an SSRF target.
    """
    from urllib.parse import urlsplit

    raw = str(value or "").strip()
    try:
        parsed = urlsplit(raw)
    except ValueError as exc:
        raise ValueError(
            "repository_url must be a public https://github.com/owner/repo URL"
        ) from exc
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("repository_url must not contain an invalid port") from exc
    if (
        parsed.scheme.lower() != "https"
        or (parsed.hostname or "").lower() != "github.com"
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("repository_url must be a public https://github.com/owner/repo URL")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        raise ValueError("repository_url must contain exactly one GitHub owner and repository")
    owner, repository = parts
    if repository.lower().endswith(".git"):
        repository = repository[:-4]
    if not _GITHUB_OWNER_RE.fullmatch(owner) or not _GITHUB_REPOSITORY_RE.fullmatch(repository):
        raise ValueError("repository_url contains an unsupported GitHub owner or repository name")
    return f"https://github.com/{owner}/{repository}"


def _validated_github_branch(value: str) -> str:
    """Accept a conservative, bounded subset of Git branch names.

    Branch names are URL-encoded again at the API boundary.  Rejecting ambiguous Git
    ref syntax here keeps the configuration understandable and prevents values such
    as ``..``, ``@{`` and ``.lock`` from ever reaching repository discovery.
    """
    branch = str(value or "").strip()
    if (
        not _GITHUB_BRANCH_RE.fullmatch(branch)
        or ".." in branch
        or "//" in branch
        or "@{" in branch
        or branch.endswith(".lock")
        or any(part.startswith(".") or part.endswith(".") for part in branch.split("/"))
    ):
        raise ValueError(
            "branch must be 1-128 ASCII letters, numbers, '.', '_', '-', or '/', "
            "without ambiguous Git ref syntax"
        )
    return branch


class ReleaseUpdateConfig(BaseModel):
    """Read-only public upstream metadata discovery.

    This block identifies release *source* branches only.  It never grants the
    backend or browser authority to clone, pull, execute, deploy, migrate, restart,
    promote, or roll back code.  Activation remains governed by the separately
    deployed same-origin release manifest and backend readiness contract.
    """

    enabled: bool = True
    repository_url: str = Field(
        default="https://github.com/ARYDESTROYER/Agentic-Kibana",
        description="Public GitHub upstream used only for release metadata discovery.",
    )
    stable_branch: str = Field(
        default="main",
        description="Protected Stable release branch (normally main).",
    )
    testing_branch: str = Field(
        default="Testing",
        description="Integration/acceptance branch used for Testing candidates.",
    )
    check_interval_minutes: int = Field(
        default=360,
        ge=15,
        le=10_080,
        description="Minimum automatic GitHub check interval (15 minutes to 7 days).",
    )

    @field_validator("repository_url")
    @classmethod
    def _repository_is_public_github(cls, value: str) -> str:
        return _canonical_public_github_repository(value)

    @field_validator("stable_branch", "testing_branch")
    @classmethod
    def _branch_is_bounded(cls, value: str) -> str:
        return _validated_github_branch(value)


class StorageLifecycleConfig(BaseModel):
    """Desired lifecycle for Agentic SOC's OWN application state.

    Connected log-source retention is intentionally excluded: those indices are
    read-only and stay operator/vendor managed.  The backend only enforces phases
    that are safe for the selected state store.  Today that means Elasticsearch ILM
    for the append-only audit and usage ledgers; mutable cases plus live KV/config
    state stay hot until an index-aware archive/restore path exists.

    The archive boundary is derived as ``hot_days + warm_days`` so independently
    entered dates cannot drift.  Glacier is a desired archive target, not a claim
    that the active state backend can restore directly from it.  This policy never
    deletes active data.
    """

    enabled: bool = True
    hot_days: int = Field(
        default=180,
        ge=1,
        le=3650,
        description="Days kept in the active hot tier before eligible state moves warm.",
    )
    warm_days: int = Field(
        default=90,
        ge=1,
        le=3650,
        description="Days kept warm before the desired archive hand-off begins.",
    )
    archive_target: Literal["aws_glacier"] = Field(
        default="aws_glacier",
        description="Desired immutable archive target; advisory until an export/restore pipeline is configured.",
    )
    glacier_storage_class: Literal["GLACIER", "DEEP_ARCHIVE"] = Field(
        default="GLACIER",
        description="S3 Glacier class for independent archive objects, never an Elasticsearch snapshot repository.",
    )
    delete_after_archive: Literal[False] = Field(
        default=False,
        description="Reserved safety policy. Deletion stays disabled until verified archive and restore exist.",
    )

    @property
    def archive_from_days(self) -> int:
        return int(self.hot_days) + int(self.warm_days)


class StandupConfig(BaseModel):
    enabled: bool = True
    window_hours: int = 24
    interval_seconds: int = 86400  # run cadence for the in-process scheduler
    # --- Round 3 attention-queue / shift-handoff toggles (ALL additive + defaulted).
    # ``attention_queue`` surfaces a prioritised "needs-you-now" list in the standup;
    # ``shift_handoff`` enables the handoff acknowledgement log (ShiftAck/ActionItem,
    # SHIFT_HANDOFF KV ns); ``include_action_items`` rolls open ActionItems into the
    # standup. A later wave wires these; here they only carry the policy. ---
    attention_queue: bool = False
    shift_handoff: bool = False
    include_action_items: bool = True


# --------------------------------------------------------------------------- #
# Round 4 — threshold tuning / batch inference / anomaly baseline / campaign
# clustering config blocks. Current autopilot defaults tuning/baseline/campaign ON;
# discounted batch inference remains opt-in. ⚠ NON-NEGOTIABLE #3: NONE feeds
# ``engine/case_manager.decide()`` — a threshold-tuning suggestion, a batch job, an
# anomaly baseline or a campaign are all ADVISORY / plumbing (they surface candidates,
# govern cost, or drive presentation); the deterministic close/escalate decision stays
# a pure fn of verdict/confidence/risk_score/policy. #6 (one UsageDoc per call) holds.
# --------------------------------------------------------------------------- #
class ThresholdTuningConfig(BaseModel):
    """Nightly threshold auto-TUNING policy (Round 4). When enabled it observes per-rule FP rates and
    PROPOSES bounded threshold adjustments (never applies them silently — the decision
    stays deterministic, #3). ``min_samples`` is the minimum observations before a
    suggestion is considered; ``max_n_step`` caps how far a correlation ``n`` may move
    per cadence; ``fp_rate_target`` is the target false-positive rate; ``wilson_z`` is
    the z-score for the Wilson confidence interval on the observed FP rate; ``ewma_alpha``
    smooths the running FP-rate estimate; ``cadence`` is when the tuner runs; and
    ``shadow_eval`` (default ON) means a suggestion is EVALUATED against recent data
    before it can be applied.

    Observation defaults ON (Autopilot overhaul), while automatic writes default OFF.
    The engine accepts only independent analyst outcomes, uses a Wilson lower bound plus
    ``min_samples``, proposes a bounded +1 (``max_n_step``) nudge, and runs mandatory
    ``shadow_eval`` before review or an explicitly enabled automatic application. A
    suppression drop always routes to HITL. Rules with enough observed volume but too few
    analyst labels produce an evidence-collection work item rather than silently training
    on model output. Defaults follow ``STANDARDS.md``: ``min_samples=30`` (Wilson-stable;
    hard floor 10), ``fp_rate_target=0.10`` (world-class SOC < 10% FP),
    ``wilson_z=1.96`` (0.95 confidence, lower bound), ``max_n_step=1`` (bounded nudge)."""

    enabled: bool = True
    min_samples: int = Field(default=30, ge=1)
    max_n_step: int = Field(default=1, ge=0)
    fp_rate_target: float = Field(default=0.10, ge=0.0, le=1.0)
    wilson_z: float = Field(default=1.96, ge=0.0)
    ewma_alpha: float = Field(default=0.2, gt=0.0, le=1.0)
    cadence: Literal["hourly", "nightly", "weekly", "manual"] = "nightly"
    shadow_eval: bool = True
    # Human approval is the safe default. A tenant may explicitly allow an automatic
    # bounded change only after ``min_samples`` independently analyst-confirmed
    # outcomes and a clean shadow evaluation. Model verdicts never satisfy that gate.
    auto_apply_confirmed: bool = False

    @model_validator(mode="after")
    def _auto_apply_requires_shadow_evaluation(self) -> "ThresholdTuningConfig":
        """Fail closed when automatic writes could bypass the retrospective replay.

        ``shadow_eval`` remains configurable for review-only observation, but an
        operator cannot combine a disabled replay with automatic threshold writes.
        The engine repeats this guard at the mutation boundary because
        ``model_copy(update=...)`` does not re-run Pydantic validation.
        """
        if self.auto_apply_confirmed and not self.shadow_eval:
            raise ValueError(
                "auto_apply_confirmed requires shadow_eval so confirmed true "
                "positives are replayed before an automatic change"
            )
        return self


class BatchConfig(BaseModel):
    """Discounted-inference policy (Round 4 cost governance).

    ``enabled`` continues to gate the true ASYNC provider-Batch event funnel. Alert
    investigations outside that funnel need an in-band answer before deterministic
    case routing can continue, so ``prefer_discounted_alerts`` independently opts
    compatible LIVE OpenAI alert calls into Flex. The gateway verifies provider/model
    support, records the tier ACTUALLY returned, and can fall back to standard service
    when Flex capacity is unavailable. Unsupported providers/models are never labelled
    or billed as discounted. #6 remains one UsageDoc per resolved call; #3 is untouched.
    """

    enabled: bool = False
    # OCSF severity_id (1-6): a candidate AT/BELOW this floor is eligible for batch
    # (slow, discounted) processing; above it stays synchronous. 3 == medium.
    severity_floor: int = Field(default=3, ge=1, le=6)
    # Backwards-compatible allow-list for the true async provider Batch API.  The
    # runtime does NOT choose the first available entry: it binds the batch provider
    # to ``router_model.provider`` and rejects a provider/model mismatch.  Keeping the
    # list preserves stored configs while making its meaning unambiguous.
    providers: list[str] = Field(default_factory=lambda: ["anthropic", "openai"])
    flex: bool = Field(
        default=False,
        deprecated=True,
        description=(
            "Legacy compatibility field; ignored by async Batch routing. Live OpenAI "
            "Flex preference is controlled only by prefer_discounted_alerts."
        ),
    )
    # Default-ON cost preference for case/alert inference. This is separate from the
    # deprecated ``flex`` field above, which is intentionally ignored.
    prefer_discounted_alerts: bool = True
    # Flex is best-effort capacity. A standard retry preserves alert processing when
    # Flex is unavailable; the fallback is metered at the standard rate, truthfully.
    fallback_to_standard: bool = True


class BaselineConfig(BaseModel):
    """Anomaly-detection BASELINE policy (Round 4). When enabled it warms per-series streaming sketches
    (:class:`app.models.BaselineState`) and flags modified-z-score deviations as
    ANOMALY candidates for triage (advisory — never feeds #3). ``half_life_days`` sets
    the EWMA decay; ``warmup_multiplier`` × ``min_samples`` guards a cold series;
    ``modified_z_threshold`` is the deviation bar; ``tdigest_compression`` bounds the
    quantile sketch size; ``seasonality`` buckets observations (e.g. hour-of-week).

    Defaults ON (Autopilot overhaul) as a PURE PRODUCER: the realtime consumer wired in
    ``state.py`` folds per-cluster and per-source volume into the sketches every tick, so
    the baseline *learns from day one* (advisory anomaly chips + silent-source/flood
    detection) WITHOUT ever driving a new LLM investigation by itself (learning-as-trigger
    stays opt-in, #3). ``max_series`` LRU-bounds the in-memory/KV cardinality on
    high-cardinality feeds (evict least-recently-updated once exceeded; 0 == unbounded).
    ``warmup_days`` is the advisory wall-clock warm-up target (Sentinel UEBA ">=14 days")
    surfaced in the UI warm-up gauge; the sketch's own warm-up gate is observation-based
    (``warmup_multiplier x seasonal_period``) and unchanged. ``modified_z_threshold=3.5``
    is the Iglewicz-Hoaglin canonical robust-outlier cutoff (``STANDARDS.md``)."""

    enabled: bool = True
    half_life_days: float = Field(default=14.0, gt=0.0)
    warmup_multiplier: int = Field(default=3, ge=1)
    warmup_days: int = Field(default=14, ge=0)
    modified_z_threshold: float = Field(default=3.5, ge=0.0)
    tdigest_compression: int = Field(default=100, ge=1)
    # LRU cardinality bound on the number of distinct series (cluster signatures +
    # per-source volume keys) held in memory / persisted. Least-recently-updated series
    # are evicted once the count exceeds this. 0 == unbounded (legacy behaviour).
    max_series: int = Field(default=50000, ge=0)
    seasonality: Literal["none", "hour_of_day", "hour_of_week", "day_of_week"] = "hour_of_week"


class CampaignConfig(BaseModel):
    """Cross-case CAMPAIGN-clustering policy (Round 4). When enabled it groups related cases (shared
    entities / overlapping MITRE) into a running :class:`app.models.Campaign` for the UI
    (advisory — it NEVER force-merges cases or feeds #3). ``cadence`` is how often the
    clustering pass runs.

    Defaults ON (Autopilot overhaul): a $0, read-time shared-entity graph that references
    ``case_ids`` only and never merges/closes — pure advisory grouping that makes
    multi-case incidents legible out of the box."""

    enabled: bool = True
    cadence: Literal["hourly", "daily", "weekly", "manual"] = "daily"


class SuppressionRule(BaseModel):
    """A field==value suppression. Matching events are dropped, not investigated.

    All fields beyond ``field``/``value``/``reason`` are ADDITIVE and defaulted, so
    rules persisted before this change deserialize unchanged and behave exactly as
    before (``enabled`` True, ``expires_at`` None == never expires). The extra
    fields carry provenance for agent-PROPOSED rules: ``confidence`` (the proposer's
    justified 0..1), ``rationale`` (why), ``source_case_ids`` (the closed case(s)
    that motivated it), ``created_by`` (``agent`` when proposer-drafted, else the
    operator), ``expires_at`` (auto-expiry so an agent rule self-retires) and
    ``enabled`` (an operator off-switch without deleting the rule)."""

    field: str
    value: str
    reason: str = ""
    confidence: float = 1.0
    rationale: str = ""
    source_case_ids: list[str] = Field(default_factory=list)
    created_by: str = ""
    # The proposal that materialised this rule. It is an additive idempotency key:
    # approval retries find the same logical side effect instead of appending twice.
    approval_proposal_id: str = ""
    expires_at: datetime | None = None
    enabled: bool = True

    def is_live(self, now: datetime | None = None) -> bool:
        """True when this rule should actively suppress: enabled AND not expired.

        Centralises the enabled/expiry check so the cost gate and the query builder
        honour it identically. A naive ``expires_at`` is treated as UTC."""
        if not self.enabled:
            return False
        if self.expires_at is not None:
            ref = now or datetime.now(timezone.utc)
            exp = self.expires_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if ref.tzinfo is None:
                ref = ref.replace(tzinfo=timezone.utc)
            if exp <= ref:
                return False
        return True


class AnalystRulePolicy(BaseModel):
    """An operator's explicit, audited, revocable statement about their OWN estate.

    This is the answer to a structural dead end: for a detection whose alerts carry no
    per-case evidence (no payload, no URI, no response code), an investigation can never
    verify that THIS instance is benign, so it correctly returns ``NEEDS_HUMAN`` however
    many analyst-confirmed benign outcomes stand behind the rule. Precedent volume
    cannot fix an evidence-sufficiency judgement. An operator therefore needs a way to
    assert a RULE-LEVEL fact and have the system act on it deterministically, instead of
    repeatedly trying to persuade a model with per-case evidence the source never emits.

    Semantics, and what it deliberately is NOT:

    * A matching cluster is CLOSED with ``disposition=false_positive`` and
      ``decision_by=analyst_policy`` (:class:`~app.constants.DecisionBy`), with **no LLM
      call at all** — cheaper, faster and more honest than a per-case argument.
    * It is NOT :class:`SuppressionRule` (field==value), which DROPS matching events
      before a case exists. This closes a VISIBLE, audited case, so the declaration
      stays reviewable and reversible and the volume stays countable.
    * It is NOT :class:`RuleSuppression` (the per-rule editor's alert-storm metadata),
      which is storage-only and never drops anything.
    * It is excluded from every agent-performance statistic (FP rate, automation rate,
      auto-close health, noise funnel, agent-improvement evidence) so it can never
      flatter the agent, and it is invisible to
      ``engine.analyst_outcomes.analyst_confirmed_outcome`` so it can never become
      training evidence for the automation that it replaces.
    * ``decide()`` is untouched (#3): this is a separate operator-authored path that
      runs BEFORE any verdict exists, never a new close authority layered onto the
      verdict policy.

    Revoking is ``enabled=False`` (or an ``expires_at`` lapse, or deleting the row);
    already-closed cases stay closed and remain reopenable by an analyst as usual.
    """

    id: str = Field(default_factory=lambda: new_id("arp-"))
    # The detection rule this declaration is about. Matched against the cluster's rule
    # values after the same normalisation the tuner uses, and ALL of a cluster's rules
    # must be declared before it closes (a cluster that also fired an undeclared
    # detection is not the thing the operator declared benign).
    rule_id: str
    # Why. Required in spirit (the audit trail is the point); empty is permitted so an
    # API client is never blocked, but the Console asks for it.
    reason: str = ""
    # Optional scope: when set, the declaration applies only to that source instance.
    # Empty/None means every source.
    source_id: str | None = None
    enabled: bool = True
    # Optional risk ceiling. ``decide()`` bounds FALSE_POSITIVE auto-close with
    # ``max_risk_score``; without an equivalent here a declared rule closes at ANY
    # computed risk. ``None`` keeps the unbounded behaviour; a number lets an operator
    # say "benign here, but investigate an unusually high-scoring instance".
    max_risk_score: float | None = Field(default=None, ge=0.0, le=100.0)
    created_by: str = ""
    created_at: str = Field(default_factory=iso_now)
    expires_at: datetime | None = None

    def is_live(self, now: datetime | None = None) -> bool:
        """True when this declaration should be honoured: enabled AND not expired.

        Mirrors :meth:`SuppressionRule.is_live` exactly so the two operator off-switches
        behave identically. A naive ``expires_at`` is treated as UTC.
        """
        if not self.enabled:
            return False
        if self.expires_at is not None:
            ref = now or datetime.now(timezone.utc)
            exp = self.expires_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if ref.tzinfo is None:
                ref = ref.replace(tzinfo=timezone.utc)
            if exp <= ref:
                return False
        return True


class PrecedentPromotionConfig(BaseModel):
    """Give analyst-confirmed precedent real weight for the SAME detection rule.

    EVIDENCE PROMOTION, not a close authority. When the rule identity under
    investigation carries a unanimous, sufficiently large body of analyst-confirmed
    benign outcomes, the investigator is told so explicitly and in STRUCTURED form —
    a code-computed count — instead of being left to infer it from a handful of
    retrieved prose snippets. The verdict still comes from the model and
    ``engine.case_manager.decide()`` still applies the auto-close policy (#3).

    Default OFF: promoting precedent changes what the model is told, and that is an
    operator decision, not something a deployment should silently acquire on upgrade.
    """

    enabled: bool = False
    # Minimum analyst-confirmed FALSE POSITIVE outcomes for the EXACT rule identity.
    min_confirmed: int = Field(default=25, ge=1, le=100000)
    # Secondary relevance floor on the retrieval RANK score of the matching precedent.
    # NOTE: with hybrid retrieval on, that score is a min-max-normalised blend of vector
    # similarity and BM25 — comparable within one retrieval, not across backends or
    # queries. RULE IDENTITY is the authoritative gate; this is only a relevance floor.
    min_similarity: float = Field(default=0.5, ge=0.0, le=1.0)
    # How many analyst-confirmed TRUE POSITIVE outcomes the rule may carry and still be
    # promotable. Default 0: a rule the analysts disagree about is not "benign here".
    max_conflicting: int = Field(default=0, ge=0, le=1000)


class PrecedentWindowConfig(BaseModel):
    """How the bounded precedent projection window is filled.

    A flat newest-N window lets ANY bulk analyst action on one rule evict every other
    rule's precedent — precedent starvation again, this time triggered by an operator
    doing exactly what the product asked of them. Stratifying round-robin across rule
    identities gives every active rule an equal floor within the same bounded window.
    """

    size: int = Field(default=200, ge=1, le=5000)
    stratify_by_rule: bool = True


class PrecedentFutilityConfig(BaseModel):
    """Surface rules whose precedent is abundant but is not changing the outcome.

    Read-only observability. Without it the product asks for more analyst confirmations
    indefinitely with no signal that they cannot help.
    """

    enabled: bool = True
    min_confirmed: int = Field(default=25, ge=1, le=100000)
    min_recent_cases: int = Field(default=10, ge=1, le=100000)
    max_auto_close_rate: float = Field(default=0.05, ge=0.0, le=1.0)


class PrecedentConfig(BaseModel):
    """Rule-identity precedent: promotion, window fairness and futility reporting.

    Nothing in this block is read by ``engine.case_manager.decide()`` (#3).
    """

    promotion: PrecedentPromotionConfig = Field(default_factory=PrecedentPromotionConfig)
    window: PrecedentWindowConfig = Field(default_factory=PrecedentWindowConfig)
    futility: PrecedentFutilityConfig = Field(default_factory=PrecedentFutilityConfig)
    # How long the per-rule corpus distribution may be reused before it is recomputed.
    # 0 disables the cache (recompute on every investigation).
    distribution_ttl_seconds: int = Field(default=300, ge=0, le=3600)


class AssetNetwork(BaseModel):
    """An internal-asset network: every IP inside ``cidr`` carries ``criticality``
    in the deterministic risk score's asset_criticality component (Section 6.2)."""

    cidr: str
    criticality: float = Field(default=0.0, ge=0.0, le=100.0)


class CrossSourceCorrelationConfig(BaseModel):
    """Optional, GLOBAL cross-source correlation (Wave 5 / F6).

    Default ``enabled=False`` so today's single-source path is byte-identical out of
    the box. When enabled, a SECOND, opt-in pass groups OPEN cases/clusters that share
    an entity (ip/host/user/file_hash/domain) within ``time_window_seconds`` ACROSS
    ``min_sources`` or more DISTINCT sources. It NEVER force-merges: the per-cluster
    1:1 signature stays intact (#4) — it only ADDS ``related_case_ids`` +
    ``cross_source_cluster_id`` to the cases, surfacing them as RELATED.

    ``entity_keys`` lists the cross-source entity types considered (a superset of the
    per-rule ladder; ``file_hash``/``domain`` are extra keys read from the raw event).

    Defaults ON (Autopilot overhaul): $0, additive ``related_case_ids`` links only, and a
    single-source tenant is a no-op — a multi-source tenant automatically sees
    related-across-sources links with no downside (#3/#4 untouched).
    """

    enabled: bool = True
    time_window_seconds: int = Field(default=300, ge=1)
    min_sources: int = Field(default=2, ge=2)
    entity_keys: list[str] = Field(
        default_factory=lambda: ["ip", "host", "user", "file_hash", "domain"]
    )


class DemoConfig(BaseModel):
    """Demo Mode (Wave 5) — a first-class, reversible, fully ISOLATED tenant state.

    Default ``mode='off'`` so the suite behaves byte-for-byte as production out of
    the box. When ``mode != 'off'`` the suite SHOWCASES the whole product with
    believable synthetic data that is generated DETERMINISTICALLY from ``seed`` and
    flows through the REAL pipeline — but every write lands in a SEPARATE in-memory
    store and a deterministic MOCK LLM, so demo is $0, isolated, and one-flip
    reversible:

    * ``off``     — disabled (the default). Real cases/metrics/cost are served.
    * ``seeded``  — a static synthetic spread (a backdated history of finished cases
                    + a benign baseline) is pre-generated at enable; no live ticking.
    * ``live``    — ``seeded`` PLUS a background ``DemoSimulator`` that emits a bounded,
                    diurnal-scaled batch each jittered tick. At each source-alert
                    interval, ``incident_rate`` is the chance of a coherent ATT&CK
                    storyline; otherwise one low-confidence native alert is emitted.

    ``run_id`` is stamped at enable and every case is tagged ``demo`` plus a run tag
    inside the physically separate store, so disable can drop the whole stack and the
    real state returns intact. Public API inputs and runtime work are bounded. The
    persisted timing/rate fields intentionally retain their legacy open upper range
    so an older saved Preferences document remains loadable after upgrade.
    """

    mode: Literal["off", "seeded", "live"] = "off"
    seed: int = 1337
    run_id: str = ""                       # stamped at enable; "" when off
    history_days: int = Field(default=14, ge=0, le=365)
    tick_seconds: float = Field(default=10.0, gt=0.0)
    tick_jitter: float = Field(default=0.3, ge=0.0, le=1.0)
    incident_rate: float = Field(default=0.05, ge=0.0, le=1.0)

    # --- Demo overhaul: four-source rates + pre-seed + forced capabilities (additive,
    # defaulted, NO migration — an absent block deserialises byte-identically). ---
    # The SIEM segment is a low-volume ALERT feed: one benign alert (or, with
    # probability ``incident_rate``, one storyline ignition) every ~2 min. The two
    # knobs COMPOSE: ``alert_interval_seconds`` is the source-alert cadence and
    # ``incident_rate`` is the chance at each alert interval of a storyline instead.
    alert_interval_seconds: float = Field(default=120.0, gt=0.0)
    # A logical benign-event throughput target (events/sec) across all four sources.
    # DemoSimulator materialises a bounded batch transiently, feeds it straight into the
    # cheap-first ``event_detection.funnel()`` (which pre-aggregates into bounded
    # per-(signature, bucket) sketches) and drops the raw list, so memory is bounded
    # by the sketch size, never by retained events.
    event_rate_per_second: float = Field(default=40.0, ge=0.0)
    # Pre-seed on enable(): a tight "just happened" window, separate from the backdated
    # ``history_days`` spread — ``preseed_case_count`` cases that "just arrived" plus
    # ``preseed_event_count`` events already batch-processed (counted in noise/metrics).
    preseed_recent_minutes: int = Field(default=10, ge=0, le=120)
    preseed_case_count: int = Field(default=3, ge=0, le=20)
    preseed_event_count: int = Field(default=100, ge=0, le=2000)
    # Force threshold_tuning / baseline / campaign / threshold_automation ON for the
    # DEMO SANDBOX ONLY while demo is engaged (never touches the real prefs these are
    # read from — see DemoStack._demo_prefs). Default True so "ALL capabilities ON in
    # demo" is the out-of-the-box behaviour; set False to inherit the live tenant's
    # (default-OFF) capability config for a "my real automation, demo data" walkthrough.
    force_capabilities: bool = True

    @property
    def active(self) -> bool:
        """True when demo mode is engaged (seeded OR live)."""
        return self.mode != "off"


class IndexPattern(BaseModel):
    """One FEED a source reads — an index pattern plus the per-feed config that
    governs how its events are read, correlated and auto-forwarded (Wave 6).

    A single source (e.g. one ELK cluster) typically has SEVERAL feeds: an alerts
    feed (``role=alerts`` — every detection triaged), an all-events feed
    (``role=events`` — correlate → auto-forward only on the allowlist) and an
    ignore feed (``role=ignore`` — muted, dropped entirely at ingest). The wire key
    stays ``config['index_patterns']`` and the class name stays ``IndexPattern`` to
    avoid a breaking rename; ``feeds()`` is the canonical accessor that returns these.

    BACK-COMPAT IS PARAMOUNT. Every field is Optional+defaulted so a stored legacy
    entry — ``{pattern, role, auto_correlate}`` OR a bare ``"all-logs-*"`` string —
    still validates and yields IDENTICAL effective behaviour:

      * ``id`` — lazy ``slug(pattern)`` when blank (deterministic; no migration).
      * ``role`` — ``events`` default; ``alerts`` auto-forwards; ``ignore`` drops.
      * ``query`` — a connector-native filter the operator authors (TRUSTED, #9 — it
        is operator config, NOT log-derived; still never interpolated into a prompt).
      * ``field_mapping`` — per-feed override; falls back to source-level then global.
      * ``message_field`` — per-feed message column override (falls back the same way).
      * ``severity_floor`` — OCSF severity_id 1-6: below it, an event is NOT
        auto-forwarded BUT is STILL correlated + live-tailed (NEVER dropped, #4).
      * ``correlate`` — the per-feed "Auto-Correlate" toggle (legacy ``auto_correlate``
        is mapped onto this); FALSE → candidate-only (manual triage), still correlated.
      * ``auto_investigate`` — None → DERIVED from role/legacy ``auto_correlate``
        (``role=='alerts' or legacy auto_correlate``); set True/False to pin it.
      * ``poll_interval_seconds`` — per-feed schedule override (None → source/global).
      * ``label`` — a human display label for the feed.

    The legacy ``auto_correlate`` attribute is preserved (read-only property aliasing
    ``correlate``) so every existing call site keeps working unchanged."""

    # ``role`` etc. are plain data, not Pydantic config — and we accept legacy keys
    # (``auto_correlate``) that are not declared fields, so we ignore extras silently.
    model_config = {"protected_namespaces": (), "extra": "ignore"}

    pattern: str
    id: str = ""
    role: IndexRole = IndexRole.EVENTS
    enabled: bool = True
    query: str | None = None
    field_mapping: dict[str, Any] = Field(default_factory=dict)
    message_field: str | None = None
    severity_floor: int | None = None
    correlate: bool = True
    auto_investigate: bool | None = None
    poll_interval_seconds: int | None = None
    label: str = ""

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy(cls, data: Any) -> Any:
        """Accept a bare-string entry and the legacy ``auto_correlate`` key.

        A bare ``"all-logs-*"`` string becomes ``{pattern: ...}``. A legacy
        ``{pattern, role, auto_correlate}`` dict maps ``auto_correlate`` onto
        ``correlate`` (only when ``correlate`` is not explicitly present), so an old
        config validates and the per-feed "Auto-Correlate" toggle reads identically."""
        if isinstance(data, str):
            return {"pattern": data}
        if isinstance(data, dict):
            d = dict(data)
            if "auto_correlate" in d and "correlate" not in d:
                d["correlate"] = d["auto_correlate"]
            return d
        return data

    @model_validator(mode="after")
    def _derive_id(self) -> "IndexPattern":
        """Lazily slug the id from the pattern when blank (deterministic, no migration)."""
        if not self.id:
            object.__setattr__(self, "id", slug(self.pattern))
        return self

    @property
    def auto_correlate(self) -> bool:
        """Legacy alias for ``correlate`` — keeps every existing call site working."""
        return self.correlate

    def effective_auto_investigate(self) -> bool:
        """Whether a cluster touching ONLY this feed auto-forwards to investigation.

        ``auto_investigate`` pins it when set; otherwise it is DERIVED to preserve
        legacy behaviour EXACTLY: an alerts-role feed auto-forwards (bypassing the
        allowlist) and an events-role feed auto-forwards only when ``correlate`` is on
        (the legacy ``auto_correlate`` semantics). An ignore feed never auto-forwards
        (it is dropped before this is consulted)."""
        if self.auto_investigate is not None:
            return self.auto_investigate
        if self.role == IndexRole.IGNORE:
            return False
        return self.role == IndexRole.ALERTS or self.correlate


# Feed is the canonical NAME for the per-feed model; the class is still called
# ``IndexPattern`` to keep the config wire key + every existing import unchanged
# (no breaking rename). New code may use either name interchangeably.
Feed = IndexPattern


def upgrade_feed(raw: Any) -> dict[str, Any]:
    """Pure migration of a LEGACY feed entry to the richer Feed dict (Wave 6).

    Accepts a bare ``"all-logs-*"`` string OR a legacy ``{pattern, role,
    auto_correlate}`` dict (or an already-rich Feed dict) and returns a plain dict
    with the derived ``id`` + the split ``correlate``/``auto_investigate`` filled in,
    yielding IDENTICAL effective behaviour:

      * ``id = slug(pattern)`` (deterministic),
      * ``correlate = legacy auto_correlate`` (default True),
      * ``auto_investigate = (role == 'alerts') or legacy auto_correlate``.

    Pure + side-effect-free: it never mutates the input and is safe to call on an
    already-upgraded entry (idempotent). NO config migration is performed anywhere —
    this exists so the UI / tests can resolve the effective shape on demand."""
    if isinstance(raw, str):
        raw = {"pattern": raw}
    if not isinstance(raw, dict):
        return {}
    d = dict(raw)
    pattern = str(d.get("pattern") or "")
    role = str(d.get("role") or "events").lower()
    if role not in ("events", "alerts", "ignore"):
        role = "events"
    # Legacy split: auto_correlate → correlate; auto_investigate derived if unset.
    if "correlate" in d:
        correlate = bool(d["correlate"])
    elif "auto_correlate" in d:
        correlate = bool(d["auto_correlate"])
    else:
        correlate = True
    ai = d.get("auto_investigate")
    if ai is None:
        ai = (role == "alerts") or correlate
    out: dict[str, Any] = {
        "id": str(d.get("id") or slug(pattern)),
        "pattern": pattern,
        "role": role,
        "enabled": bool(d.get("enabled", True)),
        "correlate": correlate,
        "auto_investigate": bool(ai),
    }
    # Carry through the optional richer fields when present (no defaults injected so
    # the dict stays minimal for a legacy entry).
    for k in ("query", "field_mapping", "message_field", "severity_floor",
              "poll_interval_seconds", "label"):
        if k in d and d[k] is not None:
            out[k] = d[k]
    return out


class SourceInstance(BaseModel):
    """One configured log source (a connector instance).

    This is what makes the suite multi-source: an operator adds N sources (an
    Elasticsearch, a Splunk, a Wazuh, a webhook, …) via the first-run wizard, each
    backed by a connector (``backend/app/connectors/``). ``config`` holds the
    connector's NON-secret settings (host, index/topic, entity field mappings,
    bind port, …); secret VALUES never live here — only the names of the secret
    fields that have been configured (``configured_secrets``). Secret values live
    in the secret tier keyed ``<id>.<field>`` and the UI only ever sees
    ``configured ✓`` (non-negotiable #10).

    An empty ``Preferences.sources`` preserves today's behaviour byte-for-byte:
    the single implicit Elasticsearch source wired from ``Secrets``.
    """

    # ``source_type`` etc. are plain data, not Pydantic config — disable the guard.
    model_config = {"protected_namespaces": ()}

    id: str
    source_type: SourceType
    display_name: str = ""
    enabled: bool = True
    ingest_mode: IngestMode = IngestMode.PULL
    # The primary log surface the agent's es_query tool + poller read from. Exactly
    # one enabled source should be primary; ``primary_source`` falls back gracefully.
    is_primary: bool = False
    config: dict[str, Any] = Field(default_factory=dict)        # non-secret connector config
    configured_secrets: list[str] = Field(default_factory=list)  # secret field names set (not values)
    created_at: str = Field(default_factory=iso_now)
    updated_at: str = Field(default_factory=iso_now)

    def index_patterns(self) -> list[IndexPattern]:
        """The configured FEEDS for this source (canonical parser).

        Reads ``config["index_patterns"]`` — a list of richer ``Feed`` dicts AND/OR
        the legacy ``{pattern, role, auto_correlate}`` dicts AND/OR bare strings, all
        of which validate to :class:`IndexPattern` (Wave 6). A malformed entry is
        skipped (as today). Falls back to the single ``config["data_view_pattern"]``
        (role=events) when none is configured. Empty when neither is set (caller uses
        global prefs). ``feeds()`` is the canonical alias for this method."""
        raw = self.config.get("index_patterns")
        out: list[IndexPattern] = []
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and item.get("pattern"):
                    try:
                        out.append(IndexPattern.model_validate(item))
                    except Exception:  # noqa: BLE001 — skip a malformed entry
                        continue
                elif isinstance(item, str) and item:
                    out.append(IndexPattern(pattern=item))
        if out:
            return out
        dv = self.config.get("data_view_pattern")
        if dv:
            return [IndexPattern(pattern=str(dv))]
        return []

    def feeds(self) -> list[IndexPattern]:
        """Canonical accessor for this source's resolved feeds (Wave 6).

        Identical to :meth:`index_patterns` — the wire key + class name are kept to
        avoid a breaking rename; this is the name new code should call."""
        return self.index_patterns()

    def live_data_view(self) -> str:
        """The comma-joined union of all ENABLED, NON-IGNORE feed patterns (Wave 6).

        This is what should be synced into ``config['data_view_pattern']`` so the
        legacy single-pattern fallback (and any reader of ``data_view_pattern``) sees
        the live log surface MINUS the muted ignore feeds. Empty when no feeds are
        configured — the caller keeps the existing ``data_view_pattern`` unchanged."""
        live = [f.pattern for f in self.index_patterns()
                if f.enabled and f.role != IndexRole.IGNORE and f.pattern]
        # Preserve order + de-dupe.
        return ",".join(dict.fromkeys(live))

    def entity_strategy(self) -> EntityStrategy | None:
        """This source's entity-resolution strategy override, or None (use global)."""
        val = self.config.get("entity_strategy")
        if not val:
            return None
        try:
            return EntityStrategy(str(val))
        except ValueError:
            return None

    def auto_correlate(self) -> bool:
        """The per-SOURCE "Auto-Correlate" toggle (Wave 5 / F6). Defaults TRUE so a
        source's clusters auto-forward to investigation exactly as today. When the
        operator sets ``config["auto_correlate"] = False``, this source's clusters
        are correlated into clusters but NOT auto-forwarded (manual triage only) —
        they still register as candidate cases (nothing is dropped, #4). A missing /
        non-bool value reads as TRUE (back-compat)."""
        val = self.config.get("auto_correlate")
        if val is None:
            return True
        if isinstance(val, bool):
            return val
        return str(val).strip().lower() not in ("false", "0", "no", "off")

    def pattern_auto_correlate(self, pattern: str | None) -> bool:
        """The per-SUB-SOURCE (index pattern) "Auto-Correlate" toggle. Returns the
        ``auto_correlate`` flag of the configured :class:`IndexPattern` whose
        ``pattern`` equals ``pattern``; TRUE when there is no matching configured
        pattern (back-compat — an unconfigured/legacy sub-source auto-forwards)."""
        if not pattern:
            return True
        for ip in self.index_patterns():
            if ip.pattern == pattern:
                return ip.auto_correlate
        return True


class RBACConfig(BaseModel):
    """Role-based access control configuration (Wave 1 / F2).

    ``enabled`` defaults to ``False`` for full back-compat: when auth is ON but RBAC
    is OFF, every authenticated user is treated as ``super_admin`` (so an existing
    single-admin deployment is unchanged). When RBAC is ON, the permission matrix in
    ``app/rbac/policy.py`` (deep-merged with any ``roles`` overrides here) is
    enforced on every gated action. ``roles`` is an ADDITIVE override: a
    role/resource not mentioned keeps its built-in default.
    """

    enabled: bool = False
    default_role: str = "analyst_tier1"
    # role -> resource -> [actions]; an empty dict means "use the built-in matrix".
    roles: dict[str, dict[str, list[str]]] = Field(default_factory=dict)
    # --- Round 3 CUSTOM ROLES (ALL additive + defaulted empty → ``effective_matrix()``
    # is byte-identical until an operator adds one). ``custom_roles`` carries
    # :class:`app.models.CustomRole`-shaped dicts (name/inherits/grants/denies); kept
    # as loose dicts here to avoid a config↔models import cycle (Wave 1 of Round 3
    # validates + resolves them into the effective matrix). ``resources`` is an
    # OVERRIDE map (role -> resource -> [actions]) layered like ``roles`` but for the
    # custom-role resolution path, and ``denies`` (role -> resource -> [actions])
    # REMOVES permissions (deny wins). All empty out of the box. ---
    custom_roles: list[dict[str, Any]] = Field(default_factory=list)
    resources: dict[str, dict[str, list[str]]] = Field(default_factory=dict)
    denies: dict[str, dict[str, list[str]]] = Field(default_factory=dict)


class SessionPolicyConfig(BaseModel):
    """Token / session lifetime + step-up policy (Wave 3: sessions & access policy).

    UI-editable; mirrors ``MfaConfig`` (a small tuning block on Preferences — NO
    secrets). The values gate the async session check in ``require_auth`` (idle +
    absolute expiry) and the ``require_fresh_auth`` step-up window. The JWT signature
    remains the root of trust; these only ADD revocation + expiry semantics.

    Defaults are DELIBERATELY GENEROUS so an existing auth-on deployment (and the
    existing auth-on tests that mint tokens directly) never expire mid-run:

    * ``access_ttl`` — short-lived ACCESS-token lifetime (seconds). Informational for
      the registry (the JWT carries its own ``exp`` via ``auth_token_hours``); a
      refresh rotates within this window. Default 1h.
    * ``idle_timeout`` — a session with no activity for this long is rejected
      (``now > last_active + idle_timeout``). Default 12h (generous).
    * ``absolute_lifetime`` — a session older than this is rejected regardless of
      activity (``now > created_at + absolute_lifetime``). Default 30 days.
    * ``refresh_ttl`` — refresh-token lifetime (seconds). Default 30 days.
    * ``sudo_reauth_window`` — how recently the user must have re-authenticated for a
      step-up-gated (``require_fresh_auth``) action. Default 10 min.
    * ``notify_on_new_device`` / ``notify_on_terminate`` — best-effort operator
      notifications on a first-seen device / a session termination (default OFF).
    """

    access_ttl: int = Field(default=3600, ge=60)             # 1h
    idle_timeout: int = Field(default=43_200, ge=300)        # 12h (generous)
    absolute_lifetime: int = Field(default=2_592_000, ge=3600)  # 30 days
    refresh_ttl: int = Field(default=2_592_000, ge=300)      # 30 days
    sudo_reauth_window: int = Field(default=600, ge=30)      # 10 min step-up window
    notify_on_new_device: bool = False
    notify_on_terminate: bool = False


class MfaConfig(BaseModel):
    """Multi-factor (TOTP) configuration (Wave 2 / F3).

    MFA is per-user opt-in; this block only tunes issuer/format + optional
    role-level enforcement. NO secrets live here (the per-user TOTP secret lives
    obfuscated on the User record; the obfuscation key is in the SECRET tier).
    ``issuer`` (blank → branding.org_name → "Agentic SOC") labels the authenticator
    entry. ``enforce_for_roles`` lists roles for which a password login is treated as
    requiring MFA even before the user enrolled (they'll be prompted to set it up)."""

    issuer: str = ""
    digits: int = Field(default=6, ge=6, le=8)
    period: int = Field(default=30, ge=10, le=120)
    enforce_for_roles: list[str] = Field(default_factory=list)


class SSOProvider(BaseModel):
    """One configured OIDC provider (Wave 2 / F4).

    The client SECRET is NOT here — it lives in the SECRET tier
    (``Secrets.sso_client_secrets[id]``); this model carries only non-secret
    configuration. ``type`` selects a discovery preset (google/microsoft) or a
    generic operator-supplied ``discovery_url``."""

    id: str
    type: Literal["google", "microsoft", "generic"] = "generic"
    display_name: str = ""
    enabled: bool = True
    client_id: str = ""
    tenant: str | None = None            # microsoft: common/organizations/{guid}
    discovery_url: str | None = None     # generic: operator-supplied
    scopes: str = "openid email profile"
    allowed_domains: list[str] = Field(default_factory=list)
    allowed_tenants: list[str] = Field(default_factory=list)
    group_claim: str | None = None
    group_role_map: dict[str, str] = Field(default_factory=dict)
    auto_create_users: bool = False
    default_role: str = "analyst_tier1"


class SSOConfig(BaseModel):
    """SSO (OIDC) configuration (Wave 2 / F4). Default OFF — full back-compat."""

    enabled: bool = False
    providers: list[SSOProvider] = Field(default_factory=list)

    def enabled_providers(self) -> list[SSOProvider]:
        """The configured providers that are enabled (when SSO is on)."""
        if not self.enabled:
            return []
        return [p for p in self.providers if p.enabled]

    def get(self, provider_id: str) -> "SSOProvider | None":
        return next((p for p in self.providers if p.id == provider_id), None)


class NotificationChannelConfig(BaseModel):
    """One configured notification channel (F5).

    NON-SECRET configuration only: the SMTP password / API key / sensitive webhook
    URL lives in the SECRET tier (``Secrets.notification_secrets[id]``, env/in-memory)
    and is resolved into the channel at send time — never persisted here, never
    returned to the UI (#10). ``config`` carries the type-specific NON-secret fields:

    * ``email``  — provider, host, port, security, username, from_addr, recipients[],
                   region (SES)
    * ``slack`` / ``teams`` / ``webhook`` — the webhook URL may be EITHER a non-secret
                   ``config["url"]`` OR the per-channel secret (preferred for sensitive
                   URLs); the secret takes precedence.
    * ``pagerduty`` — routing_key is the SECRET; source_name is non-secret config.
    * ``telegram``  — bot_token is the SECRET; chat_id is non-secret config.
    """

    model_config = {"protected_namespaces": ()}

    id: str
    type: Literal[
        "email", "resend", "slack", "teams", "webhook", "pagerduty", "telegram"
    ] = "email"
    enabled: bool = True
    name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    # The secret FIELD NAMES configured for this channel (NOT values) — UI shows ✓.
    configured_secrets: list[str] = Field(default_factory=list)


class NotificationTriggers(BaseModel):
    """When a notification fires (F5). Each boolean gates a lifecycle/verdict event;
    ``min_severity`` (0..100 risk) + ``min_risk`` floor every trigger so low-signal
    cases stay quiet. All default conservative so enabling notifications doesn't
    flood out of the box."""

    on_case_created: bool = False
    on_escalated: bool = True
    on_true_positive: bool = True
    on_needs_human: bool = False
    on_closed: bool = False
    min_severity: float = Field(default=0.0, ge=0.0, le=100.0)
    min_risk: float = Field(default=0.0, ge=0.0, le=100.0)


class NotificationDigest(BaseModel):
    """RESERVED — channel-level (email/webhook) digest batching is NOT yet implemented
    (audit #44). Setting ``enabled`` here does NOT batch network-channel sends; each
    matching event is still delivered immediately. The digest cadence that IS
    implemented is PER-USER + IN-APP: set a user's ``NotifPref.digest`` so their inbox
    items are held in a pending-digest buffer instead of arriving per-event (see
    ``NotificationService._fan_in_app`` / ``_defer_inapp``). This model is kept for
    backward/forward config compatibility; do not rely on it to throttle email/webhook
    volume until a background flush is wired."""

    enabled: bool = False
    interval_minutes: int = Field(default=60, ge=1)


class NotificationTemplateOverride(BaseModel):
    """One operator-authored template override for a single trigger (Wave 7).

    Each part is OPTIONAL — an empty string falls back to the built-in default for
    that part, so an operator can override just the subject (or just the HTML) and
    keep the shipped defaults for the rest. The strings are MUSTACHE-SUBSET templates
    rendered by :mod:`app.notifications.templates`: ``{{var}}`` is auto HTML-escaped,
    ``{{{var}}}`` is raw (TRUSTED header HTML only), ``{{#section}}`` / ``{{^section}}``
    are truthiness blocks. The variable set is WHITELISTED from ``build_meta`` so an
    operator template can never reference a non-derived (potentially unsafe) field.
    """

    model_config = {"protected_namespaces": ()}

    subject: str = ""
    html: str = ""
    text: str = ""


class NotificationTemplates(BaseModel):
    """Per-trigger template overrides (Wave 7). Each key is a trigger id
    (``case_created`` / ``escalated`` / ``true_positive`` / ``needs_human`` /
    ``closed`` / ``manual`` / ``digest_daily`` / ``test``); a missing/empty entry uses
    the shipped default template for that trigger. Defaults to no overrides (the 5
    preloaded built-in templates render verbatim)."""

    model_config = {"protected_namespaces": ()}

    overrides: dict[str, NotificationTemplateOverride] = Field(default_factory=dict)

    def override_for(self, trigger: str) -> "NotificationTemplateOverride | None":
        return self.overrides.get(trigger)


class NotificationConfig(BaseModel):
    """Pluggable notification configuration (F5). Default OFF (full back-compat —
    nothing is ever sent until an operator enables it AND configures a channel)."""

    enabled: bool = False
    channels: list[NotificationChannelConfig] = Field(default_factory=list)
    triggers: NotificationTriggers = Field(default_factory=NotificationTriggers)
    dedup_window_seconds: int = Field(default=300, ge=0)
    rate_limit_per_hour: int = Field(default=60, ge=0)
    digest: NotificationDigest = Field(default_factory=NotificationDigest)
    default_recipients: list[str] = Field(default_factory=list)
    # Operator-overridable per-trigger email templates (Wave 7). Empty → the 5
    # preloaded built-in defaults render verbatim.
    templates: NotificationTemplates = Field(default_factory=NotificationTemplates)
    # Base URL used to build the case deep-link in a notification body (e.g.
    # "https://soc.example.com"). Empty → no link is rendered.
    base_url: str = ""

    def channel(self, channel_id: str) -> "NotificationChannelConfig | None":
        return next((c for c in self.channels if c.id == channel_id), None)


# --------------------------------------------------------------------------- #
# Autopilot posture (overhaul) — one sensitivity dial that scales the three cost/
# aggression knobs. ``balanced`` is the concrete out-of-the-box default and its bounds
# match the field-level defaults above (risk floor 70 / daily $10 / per-tick cap 25),
# so a fresh install with ``autopilot_profile='balanced'`` is internally consistent.
# The resolver is a pure map; a caller (settings PUT / migration / the webui) applies a
# profile by writing these three values. It NEVER feeds ``decide()`` (#3).
# --------------------------------------------------------------------------- #
AUTOPILOT_PROFILES: dict[str, dict[str, float]] = {
    "conservative": {
        "auto_investigate_risk_floor": 90,   # cross-vendor Critical floor (max precision)
        "daily_usd": 5.0,                    # ~10-15 deep investigations
        "max_auto_investigations_per_tick": 10,
    },
    "balanced": {
        "auto_investigate_risk_floor": 70,   # cross-vendor High floor (STANDARD)
        "daily_usd": 10.0,                   # ~20-40 Opus investigations
        "max_auto_investigations_per_tick": 25,
    },
    "aggressive": {
        "auto_investigate_risk_floor": 40,   # cross-vendor Medium floor (max recall)
        "daily_usd": 50.0,                   # mid/large SOC volume
        "max_auto_investigations_per_tick": 100,
    },
}

# Bumped whenever the default posture changes in a way a STORED (pre-overhaul) config
# should adopt exactly once. A stored config lacking this / carrying a lower value is
# migrated to the new ON defaults + flagged with ``show_autopilot_banner`` (see the
# ``_migrate_autopilot`` before-validator on :class:`Preferences`). Fresh installs get the
# field default (== CURRENT) and are NEVER flagged.
CURRENT_AUTOPILOT_CONFIG_VERSION = 1

# Keys that are ALWAYS present in a full persisted ``Preferences`` dump but essentially
# never in a small programmatic construction (a test that does
# ``Preferences(campaign=CampaignConfig(enabled=False))`` passes only the one key). The
# migration therefore fires ONLY for a genuine persisted document and never clobbers an
# explicit programmatic opt-out.
_PERSISTED_CONFIG_MARKERS = ("data_view_pattern", "poll_interval_seconds", "setup_complete")


class Preferences(BaseModel):
    """The complete UI-editable configuration. Every field has a working default."""

    @model_validator(mode="before")
    @classmethod
    def _migrate_autopilot(cls, data: Any) -> Any:
        """AUTO-ADOPT + banner: a STORED ``Preferences`` predating the Autopilot overhaul
        (its ``autopilot_config_version`` is absent / < current) adopts the new default-ON
        smart-defaults ONCE and is flagged with ``show_autopilot_banner=True`` so the
        change is announced, not silent (DECISIONS #v / #v-a).

        Precisely:
        * A FRESH install (``data`` is empty / not a persisted doc) is left untouched → the
          field defaults apply (ON, ``autopilot_config_version=CURRENT``, banner False).
        * A programmatic construction (e.g. ``Preferences(campaign=CampaignConfig(
          enabled=False))`` in a test) lacks the full-dump markers → left untouched, so an
          explicit opt-out is respected byte-for-byte.
        * A persisted doc already at CURRENT is left untouched → an explicit opt-out saved
          AFTER the marker is NEVER re-overwritten (respect stored intent).
        * A persisted doc BELOW current adopts the ON defaults for the master switch,
          budget backstop + the $0 smart engines (merged so unrelated sub-fields survive),
          sets the banner, and stamps the marker so it never re-migrates.

        Additive + #3-safe: it only flips advisory/plumbing/config-writer engines +
        routing/cost knobs; it never touches ``decide()`` or a verdict."""
        if not isinstance(data, dict) or not data:
            return data
        # Only a genuine persisted document (a full dump) carries these markers; a targeted
        # programmatic construction does not → never clobber an explicit opt-out.
        if not all(k in data for k in _PERSISTED_CONFIG_MARKERS):
            return data
        try:
            stored_version = int(data.get("autopilot_config_version", 0) or 0)
        except (TypeError, ValueError):
            stored_version = 0
        if stored_version >= CURRENT_AUTOPILOT_CONFIG_VERSION:
            return data

        data = dict(data)  # copy — never mutate the caller's dict in place

        def _merge_enabled(
            key: str,
            extra: dict[str, Any] | None = None,
            forced: dict[str, Any] | None = None,
        ) -> None:
            """Set ``<key>.enabled=True`` while preserving every other stored sub-field of
            that nested config block. ``extra`` keys are filled only when ABSENT
            (``setdefault`` — a stored value wins); ``forced`` keys are OVERWRITTEN
            unconditionally — reserved for mandatory safety rails that a migrated tenant
            must not be able to have left in an unsafe stored state."""
            cur = data.get(key)
            merged = dict(cur) if isinstance(cur, dict) else {}
            merged["enabled"] = True
            for k, v in (extra or {}).items():
                merged.setdefault(k, v)
            for k, v in (forced or {}).items():
                merged[k] = v
            data[key] = merged

        # Master switch + the deterministic risk gate (adopt the new default floor).
        data["background_scan_enabled"] = True
        data.setdefault("auto_investigate_risk_floor", 70)
        # $0 / #3-safe smart engines flip ON. For the tuner, ``shadow_eval`` is a
        # MANDATORY safety rail (a suggestion is evaluated against recent data before it
        # can apply — "never hides a confirmed TP"), so it is FORCED True unconditionally:
        # auto-ENABLING the tuner while preserving a stored ``shadow_eval=False`` would
        # silently defeat that rail for migrated tenants. All other stored tuner sub-fields
        # (min_samples / cadence / …) are preserved by the merge.
        _merge_enabled("threshold_tuning", forced={"shadow_eval": True})
        _merge_enabled("campaign")
        _merge_enabled("cross_source_correlation")
        _merge_enabled("sla")
        _merge_enabled("priority_matrix")
        _merge_enabled("realtime")
        _merge_enabled("threshold_automation")   # engine on; rules stay whatever was stored ([] OOTB)
        _merge_enabled("baseline")               # producer on (realtime consumer in state.py)
        # Default budget backstop: provider spend stops at the configured ceiling;
        # the pipeline still persists a NEEDS_HUMAN case (never a silent drop/close).
        budget = data.get("budget")
        budget = dict(budget) if isinstance(budget, dict) else {}
        budget["enabled"] = True
        if not budget.get("daily_usd"):
            budget["daily_usd"] = 10.0
        budget.setdefault("on_exceed", "block")
        data["budget"] = budget
        # Per-tick auto-investigation cap (adopt the balanced default when unset).
        caps = data.get("caps")
        caps = dict(caps) if isinstance(caps, dict) else {}
        caps.setdefault("max_auto_investigations_per_tick", 25)
        data["caps"] = caps

        data["show_autopilot_banner"] = True
        data["autopilot_config_version"] = CURRENT_AUTOPILOT_CONFIG_VERSION
        return data

    @staticmethod
    def autopilot_bounds(profile: str) -> dict[str, float]:
        """The (risk-floor, daily-$, per-tick-cap) bounds for an autopilot ``profile``.

        Pure resolver over :data:`AUTOPILOT_PROFILES`; an unknown profile falls back to
        ``balanced`` (the standard). A caller applies a profile by writing these three
        values onto ``auto_investigate_risk_floor`` / ``budget.daily_usd`` /
        ``caps.max_auto_investigations_per_tick``. NEVER feeds ``decide()`` (#3)."""
        return dict(AUTOPILOT_PROFILES.get(profile, AUTOPILOT_PROFILES["balanced"]))

    def apply_autopilot_profile(self, profile: str) -> "Preferences":
        """Return this Preferences with the three autopilot knobs set from ``profile``
        (a new model; the original is untouched). The webui/settings path uses the
        deep-merge PUT instead; this helper is for programmatic callers/tests."""
        bounds = self.autopilot_bounds(profile)
        updated = self.model_copy(deep=True)
        updated.autopilot_profile = profile if profile in AUTOPILOT_PROFILES else "balanced"
        updated.auto_investigate_risk_floor = int(bounds["auto_investigate_risk_floor"])
        updated.caps.max_auto_investigations_per_tick = int(bounds["max_auto_investigations_per_tick"])
        updated.budget.daily_usd = float(bounds["daily_usd"])
        return updated

    @model_validator(mode="before")
    @classmethod
    def _migrate_fp_auto_close(cls, data: Any) -> Any:
        """Back-compat: a stored config predating ``auto_close`` carried only
        ``fp_auto_close``. Map it into ``auto_close.false_positive`` so old persisted
        preferences keep their FP auto-close behaviour. Only applied when the new
        ``auto_close`` key is absent; new configs set ``auto_close`` directly."""
        if isinstance(data, dict) and data.get("fp_auto_close") and "auto_close" not in data:
            fp = data["fp_auto_close"]
            if isinstance(fp, dict):
                data = dict(data)
                data["auto_close"] = {
                    "false_positive": {
                        "enabled": fp.get("enabled", False),
                        "min_confidence": fp.get("min_confidence", 0.95),
                        "max_risk_score": fp.get("max_risk_score", 30.0),
                        "objection_window_minutes": fp.get("objection_window_minutes", 60),
                    }
                }
        return data

    @model_validator(mode="before")
    @classmethod
    def _repair_known_invalid_embedding_role(cls, data: Any) -> Any:
        """Repair a persisted completion model accidentally assigned to embeddings.

        Older settings surfaces offered every catalog model for every role, so a
        stored GPT/Claude completion assignment could reach RAG and silently fall
        back to local vectors. Known catalog rows without ``embedding`` capability
        migrate to the dedicated OpenAI embedding default. Unknown/custom models are
        preserved because their capability cannot be inferred here; new settings
        writes validate the explicit catalog capability at the API boundary.
        """
        if not isinstance(data, dict):
            return data
        raw = data.get("embedding_model")
        if not isinstance(raw, dict):
            return data
        model = str(raw.get("model") or "").strip()
        if not model:
            return data
        from .llm.pricing import registry_entry, model_supports_capability

        if registry_entry(model) is None or model_supports_capability(model, "embedding"):
            return data
        repaired = dict(data)
        repaired["embedding_model"] = ModelConfig(
            provider="openai", model="text-embedding-3-small"
        ).model_dump(mode="json")
        return repaired

    # --- Configured log sources (vendor-agnostic ingest). Empty == the legacy
    # single implicit Elasticsearch source from Secrets (full back-compat). ---
    sources: list[SourceInstance] = Field(default_factory=list)

    # --- Data scope (Section 5.2) ---
    data_view_pattern: str = "all-logs-*"
    time_field: str = "@timestamp"

    # --- Manual investigate (Surface 2) ---
    # Starting lookback window for a manual entity investigation. If the configured
    # window yields zero events the investigate path auto-widens through a ladder
    # (this window -> now-7d -> now-30d -> now-1y) before giving up, so an entity
    # whose only activity is older than the default window still resolves.
    investigate_lookback: str = "now-24h"
    # When a case's originating events have aged out of the retained log window, an
    # operator-triggered re-investigation (reinvestigate / run-playbook) rebuilds a
    # minimal cluster from the case's STORED evidence rather than failing. This flag
    # is the (default-OFF) opt-in for the FUTURE auto-trigger — re-run key-blocked
    # cases automatically when a model/provider API key is (re)provided. The one-shot
    # manual reinvestigate-from-stored-evidence path is always available; only the
    # automatic on-key-change trigger is gated here. (UI/wiring is a follow-up.)
    reinvestigate_on_key_change: bool = False

    # --- Entity field mapping (Section 5.3) ---
    source_ip_field: str = "source.ip"
    user_field: str = "user.name"
    host_field: str = "host.name"
    # The field carrying the human-readable event message (browse/chat "message"
    # column). Configurable per source via SourceInstance.config; defaults to ECS.
    message_field: str = "message"

    # --- Entity-agnostic correlation strategy (NO-SOURCE-IP fix) ---
    # How correlation resolves the grouping entity for an event. ``auto`` (default)
    # tries the per-rule ``group_by`` first (byte-identical to before for events
    # that have it) and, ONLY when that entity is missing, falls back IP → HOST →
    # USER → RULE so an in-scope event is never silently dropped. ``ip``/``host``/
    # ``user`` pin one entity (still RULE-fallback when missing); ``rule`` always
    # groups by rule. Overridable per source via SourceInstance.config.
    entity_strategy: EntityStrategy = EntityStrategy.AUTO

    # --- Rule / severity identification (upstream emits heterogeneous fields) ---
    rule_field: str = "event.module"        # per-event rule identity (always present upstream)
    rule_name_field: str = "rule.name"
    severity_field: str = "event.severity"
    severity_threshold: float = 0.0         # min numeric severity in scope
    in_scope_rules: list[str] = Field(default_factory=list)   # empty == all rules
    excluded_rules: list[str] = Field(default_factory=list)

    # --- Case evidence projected into prompts + searched by free text ---
    # The extra raw-record paths the investigator/router see per sample event, the
    # ``es_query`` tool returns per row, and free-text ``contains`` is matched
    # against. ONE list drives all three (``app/evidence_fields.py``) so a field can
    # never again be invisible in the prompt AND unmatchable in the query at the
    # same time. Defaults to the ECS set that most often carries the verdict; set
    # ``["*"]`` to ship the whole record bounded only by the size budget below, or
    # ``[]`` for the pre-0.1.13 identity-only projection. Overridable per source via
    # ``SourceInstance.config["evidence_fields"]``.
    evidence_fields: list[str] = Field(
        default_factory=lambda: list(DEFAULT_EVIDENCE_FIELDS)
    )
    # Serialised-character budget for ONE projected event. When it binds, the
    # projection drops rule-DEFINITION metadata first and names what it withheld
    # back to the model, rather than cutting blindly mid-record.
    evidence_max_chars_per_event: int = Field(
        default=DEFAULT_EVIDENCE_MAX_CHARS_PER_EVENT,
        ge=0,
        le=MAX_EVIDENCE_MAX_CHARS_PER_EVENT,
    )

    # --- Polling (Section 6.1) ---
    poll_interval_seconds: int = 30
    poll_batch_size: int = 500
    cold_start_lookback_minutes: int = 60
    polling_enabled: bool = True

    # --- Models per role (Section 6.4) ---
    router_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(max_tokens=600)
    )
    investigator_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(max_tokens=2000)
    )
    formatter_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(max_tokens=1200)
    )
    standup_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(max_tokens=1200)
    )
    chat_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(max_tokens=1500)
    )
    # Single-event AI overview (Feature 2): follows the shared completion default.
    overview_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(max_tokens=900)
    )
    embedding_model: ModelConfig = Field(
        default_factory=lambda: ModelConfig(provider="openai", model="text-embedding-3-small")
    )

    # --- Decision thresholds (Section 8.5) ---
    # Auto-close policy (operator-tunable, per-verdict-class) — enforced
    # deterministically in case_manager.decide(). ``fp_auto_close`` is the
    # DEPRECATED predecessor, migrated into ``auto_close.false_positive`` by the
    # ``before`` validator below when a stored config predates ``auto_close``.
    fp_auto_close: FpAutoCloseConfig = Field(default_factory=FpAutoCloseConfig)
    auto_close: AutoClosePolicy = Field(default_factory=AutoClosePolicy)
    escalation_confidence: float = 0.6      # >= this on TRUE_POSITIVE = high-priority human
    critical_severity: float = 7.0

    # --- Rule catalog (C3-1): config-driven, pre-baked-but-editable detection
    # rules incl. ModSec sub-rules. Seeded on first run only (see
    # ``rule_catalog_seed_version``); an empty catalog preserves today's single
    # ``rule_field`` behaviour byte-for-byte. ---
    rule_catalog: list[RuleDefinition] = Field(default_factory=list)
    # Tracks which seed version produced the built-in rules; lets seeding be a
    # no-op once current and NEVER clobber an operator-edited (non-empty) catalog.
    rule_catalog_seed_version: int = 0
    # --- Per-rule model selection (C3-6b): keyed by rule name. Lower precedence
    # than a matching RuleDefinition.model_override, higher than model_for(). ---
    rule_model_override: dict[str, ModelConfig] = Field(default_factory=dict)

    # --- Correlation (Section 6.2) ---
    default_correlation: CorrelationRule = Field(default_factory=CorrelationRule)
    correlation_rules: dict[str, CorrelationRule] = Field(default_factory=dict)
    # Optional, GLOBAL cross-source correlation (Wave 5 / F6). Default OFF →
    # single-source behaviour is byte-identical. When enabled, an additive pass links
    # open cases sharing an entity across >= min_sources sources (RELATED, never merged).
    cross_source_correlation: CrossSourceCorrelationConfig = Field(
        default_factory=CrossSourceCorrelationConfig
    )
    risk_weights: RiskWeights = Field(default_factory=RiskWeights)
    asset_criticality: dict[str, float] = Field(default_factory=dict)  # entity value -> 0..100
    # CIDR-based internal-asset criticality (an IP inside a CIDR inherits its
    # criticality; max wins; falls back to the exact-value map above).
    asset_networks: list[AssetNetwork] = Field(default_factory=list)

    # --- Cost gate / caps (Section 6.3) ---
    caps: CapsConfig = Field(default_factory=CapsConfig)
    suppression_rules: list[SuppressionRule] = Field(default_factory=list)
    # Operator declarations that a detection is benign in THIS estate. Honoured
    # deterministically with no LLM call, under the distinct ``analyst_policy`` decision
    # owner, and excluded from every agent-performance statistic. Empty by default —
    # nothing changes until an operator explicitly declares something.
    analyst_rule_policies: list[AnalystRulePolicy] = Field(default_factory=list)

    # --- Automated scans (Surface 3) ---
    # Autopilot overhaul: the master switch defaults ON so a zero-config install actually
    # reasons over every alert + risk-scores every event (the single biggest OOTB lever).
    # Auto-investigation stays BOUNDED by the deterministic risk gate below + the per-tick
    # cap + the default budget backstop, so "read everything" can never become "spend
    # everything". Flip False to fully halt auto-investigation. Never feeds #3.
    background_scan_enabled: bool = True
    auto_forward_allowlist: list[str] = Field(default_factory=list)  # rule values that auto-scan
    # Autopilot overhaul: the deterministic RISK GATE for events-role clusters — a cluster
    # auto-forwards to the strong LLM investigator when it is alerts-role (bypasses the
    # gate) OR its deterministic ``risk_score >= auto_investigate_risk_floor``. Below-floor
    # events-role clusters stay $0 CANDIDATES (risk-scored + visible, never dropped, #4).
    # Default 70 == the cross-vendor "High" escalate floor (Elastic entity-risk banding,
    # STANDARDS.md). The ``autopilot_profile`` dial scales it (conservative 90 / balanced
    # 70 / aggressive 40). Advisory to routing only — NEVER feeds ``decide()`` (#3).
    auto_investigate_risk_floor: int = Field(default=70, ge=0, le=100)

    # --- Enrichment / RAG / standup (Surfaces 3-4, Section 6.5/6.6) ---
    enrichment: EnrichmentConfig = Field(default_factory=EnrichmentConfig)
    rag: RagConfig = Field(default_factory=RagConfig)
    standup: StandupConfig = Field(default_factory=StandupConfig)
    trace: TraceConfig = Field(default_factory=TraceConfig)
    # Multi-agent roster + plain-text runbooks/playbooks (Vigil-inspired). All
    # default ON and degrade to prior behaviour when disabled.
    personas: PersonaConfig = Field(default_factory=PersonaConfig)
    runbooks: RunbookConfig = Field(default_factory=RunbookConfig)
    playbooks: PlaybookConfig = Field(default_factory=PlaybookConfig)
    # Threat-context case panel (Wave 6 / F11) — advisory, read-only, fail-open.
    threat_context: ThreatContextConfig = Field(default_factory=ThreatContextConfig)
    # Threshold automation (Wave 6 / F10) — default OFF; post-decision, #3-safe. It
    # runs AFTER the deterministic decision + save and may only tag/recommend/notify/
    # queue a re-investigation/request HITL approval — never set status or close.
    threshold_automation: ThresholdAutomationConfig = Field(
        default_factory=ThresholdAutomationConfig
    )
    # Operator-customisable branding/appearance (org logo + name + accent + theme).
    branding: BrandingConfig = Field(default_factory=BrandingConfig)
    # ORG-level pervasive-customization defaults (Wave 7): terminology label
    # overrides, org-shared saved views, org default theme. The ORG side of the
    # two-store customization model — merged ORG ← USER by the cascade resolver.
    # Admin-edited (settings PUT + the dedicated /api/prefs/org + /api/terminology
    # routes). All free-text is plain data, never an LLM prompt input (#9).
    customization: CustomizationConfig = Field(default_factory=CustomizationConfig)
    # Customisable human-facing case-ID nomenclature (F7). Default OFF → the UI
    # shows ``case_id`` exactly as before; enabling renders ``Case.case_number``.
    case_id_format: CaseIdFormatConfig = Field(default_factory=CaseIdFormatConfig)
    # Role-based access control (Wave 1). Default OFF → every authenticated user is
    # treated as super_admin (back-compat with the single-admin deployment).
    rbac: RBACConfig = Field(default_factory=RBACConfig)
    # Multi-factor auth (Wave 2 / F3) — per-user opt-in; this block only tunes
    # issuer/format + optional role enforcement (no secrets here).
    mfa: MfaConfig = Field(default_factory=MfaConfig)
    # Session / token policy (Wave 3) — idle/absolute TTL + step-up window + notify
    # toggles. Generous defaults so an existing auth-on deployment never expires
    # mid-run; enforced by the async session check in require_auth (no secrets here).
    session_policy: SessionPolicyConfig = Field(default_factory=SessionPolicyConfig)
    # SSO / OIDC (Wave 2 / F4) — default OFF; client secrets stay in the SECRET tier.
    sso: SSOConfig = Field(default_factory=SSOConfig)
    # Notifications (Wave 4 / F5) — default OFF; per-channel secrets stay in the
    # SECRET tier. Fires fire-and-forget AFTER the deterministic decision + save;
    # a send (or failure) can never block or alter the case decision/flow (#3).
    notifications: NotificationConfig = Field(default_factory=NotificationConfig)

    # Demo Mode (Wave 5) — reversible, isolated synthetic showcase. Default OFF so
    # production behaviour is byte-identical. When active, READ endpoints serve a
    # SEPARATE in-memory demo store (real cases hidden) and writes are $0 / mocked.
    demo: DemoConfig = Field(default_factory=DemoConfig)

    # --- Round 3 (additive/safe; budget and realtime are ON in the current autopilot;
    # NONE feeds case_manager.decide(), #3). SLA timers + ITIL priority matrix
    # (presentation/reporting), the LLM cost-budget ceiling (cost governance — gates
    # whether work RUNS, never alters a decision), and live-update transport. ---
    sla: SlaPolicy = Field(default_factory=SlaPolicy)
    priority_matrix: PriorityMatrix = Field(default_factory=PriorityMatrix)
    budget: BudgetConfig = Field(default_factory=BudgetConfig)
    realtime: RealtimeConfig = Field(default_factory=RealtimeConfig)
    # Public upstream metadata only. The corresponding service is hard-pinned to
    # api.github.com, cached, bounded, and read-only; this configuration can never
    # deploy or activate code.
    release_updates: ReleaseUpdateConfig = Field(default_factory=ReleaseUpdateConfig)
    # OWN-state retention intent.  Safe native enforcement is capability-aware:
    # Elasticsearch manages append-only audit/usage with ILM; mutable cases, live
    # configuration, connected source logs, and unsupported SQL tiers remain hot.
    storage_lifecycle: StorageLifecycleConfig = Field(default_factory=StorageLifecycleConfig)

    # --- Round 4 (tuning/baseline/campaign ON; batch inference remains opt-in;
    # NONE feeds case_manager.decide(), #3; #6 preserved). Nightly threshold auto-tuning
    # (proposes, never applies silently), batch-inference routing (cost governance —
    # gates HOW work runs, never alters a decision), streaming anomaly baselines
    # (surface candidates), and cross-case campaign clustering (presentation). ---
    threshold_tuning: ThresholdTuningConfig = Field(default_factory=ThresholdTuningConfig)
    batch: BatchConfig = Field(default_factory=BatchConfig)
    baseline: BaselineConfig = Field(default_factory=BaselineConfig)
    campaign: CampaignConfig = Field(default_factory=CampaignConfig)

    # --- Rule-identity precedent (promotion / window fairness / futility) ---
    # Promotion is OFF by default (it changes what the investigator is told). The window
    # stratification and the futility report are ON: both are $0 read-side fairness and
    # observability fixes, and a flat precedent window is an outage waiting to happen.
    # None of it feeds ``case_manager.decide()`` (#3).
    precedent: PrecedentConfig = Field(default_factory=PrecedentConfig)

    # --- Autopilot posture (overhaul) ---
    # One sensitivity dial that scales the three cost/aggression knobs
    # (auto_investigate_risk_floor / budget.daily_usd / caps.max_auto_investigations_per_tick)
    # via :func:`autopilot_bounds`. ``balanced`` is the OOTB default and its bounds equal the
    # field defaults, so a fresh install is internally consistent. Advisory routing/cost only
    # — NEVER feeds ``decide()`` (#3).
    autopilot_profile: Literal["conservative", "balanced", "aggressive"] = "balanced"
    # Migration marker: the posture version this stored config has adopted. A stored config
    # below :data:`CURRENT_AUTOPILOT_CONFIG_VERSION` auto-adopts the ON defaults ONCE via the
    # ``_migrate_autopilot`` before-validator; fresh installs get CURRENT directly.
    autopilot_config_version: int = Field(default=CURRENT_AUTOPILOT_CONFIG_VERSION, ge=0)
    # One-time UI reassurance banner: set True only when an UPGRADE auto-adopted the new
    # default-ON posture (so a suddenly-triaging install is announced, not surprising). The
    # webui clears it after showing it once. False on every fresh install.
    show_autopilot_banner: bool = False

    # --- Misc ---
    setup_complete: bool = False
    read_only_settings_mode: bool = False

    def correlation_for(self, rule_value: str) -> CorrelationRule:
        """Return the correlation rule for a given rule value, or the default."""
        return self.correlation_rules.get(rule_value, self.default_correlation)

    def evidence_fields_from_config(
        self, config: "Mapping[str, Any] | None"
    ) -> tuple[str, ...]:
        """One source's effective evidence projection, from its raw connector config.

        The single expression of the source-over-global precedence, so the two
        callers that resolve it — the prompt path (by source id, through
        :meth:`evidence_fields_for`) and the ``es_query`` tool (directly, from the
        connector it is bound to) — cannot disagree. An absent key inherits the
        global list; an explicit ``[]`` is an operator pinning the narrow
        identity-only projection.
        """
        raw = (config or {}).get("evidence_fields")
        if raw is None:
            return normalise_evidence_fields(self.evidence_fields)
        return normalise_evidence_fields(raw)

    def evidence_budget_from_config(self, config: "Mapping[str, Any] | None") -> int:
        """One source's effective per-event budget, clamped. See above for precedence."""
        raw = (config or {}).get("evidence_max_chars_per_event")
        if raw is None:
            return self.evidence_budget()
        return clamp_evidence_budget(raw)

    def evidence_fields_for(
        self, source_ids: Sequence[str] | None = None
    ) -> tuple[str, ...]:
        """The effective evidence projection for a cluster, by contributing source.

        A cluster can span sources (cross-source correlation), so per-source lists
        are UNIONED in source order rather than one winning. Union, not replace,
        because dropping a source's decision field just because a co-correlated
        source pinned a narrower list is precisely the invisible-field failure this
        projection exists to prevent. A wildcard on any contributing source wins, it
        being the superset of every other answer.

        With no ``source_ids`` (or none of them configured) this is the global
        ``evidence_fields``, which is what a single-source deployment always gets.
        """
        global_fields = normalise_evidence_fields(self.evidence_fields)
        if not source_ids:
            return global_fields
        by_id = {s.id: s for s in self.sources}
        out: list[str] = []
        seen: set[str] = set()
        matched = False
        for source_id in source_ids:
            source = by_id.get(source_id)
            if source is None:
                continue
            matched = True
            resolved = self.evidence_fields_from_config(source.config)
            if is_wildcard(resolved):
                return (EVIDENCE_WILDCARD,)
            for path in resolved:
                if path not in seen:
                    seen.add(path)
                    out.append(path)
        if not matched:
            return global_fields
        return normalise_evidence_fields(out)

    def evidence_budget(self) -> int:
        """The global per-event serialised-character budget, clamped to range.

        Clamped at READ time because the same key is overlaid per source through
        ``model_copy(update=...)``, which does not validate.
        """
        return clamp_evidence_budget(self.evidence_max_chars_per_event)

    def evidence_budget_for(self, source_ids: Sequence[str] | None = None) -> int:
        """The per-event budget for a cluster, by contributing source.

        Resolved alongside :meth:`evidence_fields_for` so the prompt path applies the
        SAME per-source configuration to both halves of the projection — a per-source
        field list honoured against a global budget would silently withhold the very
        fields that source was configured to surface. A cluster spanning sources takes
        the most generous budget, matching the union semantics of the field list.
        """
        if not source_ids:
            return self.evidence_budget()
        by_id = {s.id: s for s in self.sources}
        budgets = [
            self.evidence_budget_from_config(source.config)
            for source_id in source_ids
            if (source := by_id.get(source_id)) is not None
        ]
        return max(budgets) if budgets else self.evidence_budget()

    def free_text_search_fields(self) -> list[str]:
        """The fields a connector matches a free-text ``contains`` against.

        Derived from the SAME ``evidence_fields`` the prompt projection uses, so a
        field the model can see is a field the model can then search for.
        """
        return _resolve_free_text_search_fields(
            rule_name_field=self.rule_name_field,
            message_field=self.message_field,
            evidence_fields=self.evidence_fields,
        )

    def entity_strategy_for(self, source: "SourceInstance | None") -> EntityStrategy:
        """The effective entity-resolution strategy for a source: the source's own
        ``config["entity_strategy"]`` override, else the global default. Keeps the
        entity-agnostic fallback per-source configurable (NO-SOURCE-IP fix)."""
        if source is not None:
            override = source.entity_strategy()
            if override is not None:
                return override
        return self.entity_strategy

    def primary_source(self) -> "SourceInstance | None":
        """The source the poller + es_query read from.

        Only PULL sources can be primary. Push/queue/object receivers have no query
        surface and must never be reinterpreted as an Elasticsearch connector.
        Prefers the enabled pull source explicitly flagged ``is_primary``; else the
        first enabled pull source; else None. An entirely empty source list retains
        the legacy implicit Elasticsearch behavior; a non-empty push-only list is
        handled by a no-query connector in :class:`AppState`.
        """
        if not self.sources:
            return None
        try:
            # Registry authority also protects old persisted receiver rows that
            # predate ``ingest_mode`` and therefore deserialize with its PULL default.
            from .connectors.registry import get_registry

            registry = get_registry()
            eligible = [
                source
                for source in self.sources
                if source.enabled
                and not registry.is_receiver(source.source_type)
                and (
                    registry.is_pull(source.source_type)
                    or source.ingest_mode == IngestMode.PULL
                )
            ]
        except Exception:  # noqa: BLE001 — config loading must remain fail-safe
            eligible = [
                source
                for source in self.sources
                if source.enabled and source.ingest_mode == IngestMode.PULL
            ]
        primary = next((s for s in eligible if s.is_primary), None)
        if primary is not None:
            return primary
        return eligible[0] if eligible else None

    def source_by_id(self, source_id: str | None) -> "SourceInstance | None":
        """The configured source whose ``id`` matches ``source_id`` (or None).

        Used by the poller fan-out (Round 4) so each per-source :class:`Poller`
        resolves ITS OWN :class:`SourceInstance` — e.g. for the per-source entity
        strategy — instead of always the primary. A falsy id, or an id that matches
        no configured source (e.g. the legacy implicit source_type default id like
        ``"elasticsearch"``), returns None so the caller falls back to the primary
        source's / global strategy, preserving single-source behaviour."""
        if not source_id:
            return None
        return next((s for s in self.sources if s.id == source_id), None)

    def match_rule(self, src: dict[str, Any]) -> RuleDefinition | None:
        """Classify a raw log ``_source`` against the rule catalog (C3-1).

        Evaluates ENABLED rules in ascending ``priority`` (ties broken by their
        order in the catalog) and returns the FIRST whose ``match`` matches, so a
        lower-priority ModSec sub-rule wins over the generic ``modsec_audit_log``
        rule. Returns ``None`` when nothing matches (caller falls back to today's
        single-``rule_field`` derivation)."""
        ordered = sorted(
            (rd for rd in self.rule_catalog if rd.enabled),
            key=lambda rd: rd.priority,
        )
        for rd in ordered:
            if rd.match.matches(src):
                return rd
        return None

    def correlation_for_def(self, rd: "RuleDefinition | None") -> CorrelationRule:
        """Resolve the correlation rule for a matched RuleDefinition (C3-1).

        Precedence mirrors how ``correlate`` resolves a bucket today:
        ``rd.correlation`` (inline override) → ``correlation_rules[rd.name]`` →
        ``default_correlation``. With no matched def, falls back to the default."""
        if rd is not None and rd.correlation is not None:
            return rd.correlation
        if rd is not None:
            return self.correlation_rules.get(rd.name, self.default_correlation)
        return self.default_correlation

    def model_for(self, role: str) -> ModelConfig:
        mapping = {
            "router": self.router_model,
            "investigator": self.investigator_model,
            "formatter": self.formatter_model,
            "standup": self.standup_model,
            "chat": self.chat_model,
            "overview": self.overview_model,
            "embedding": self.embedding_model,
        }
        return mapping.get(role, self.router_model)

    def maybe_seed_rule_catalog(self) -> bool:
        """Idempotently seed the built-in rule catalog IN PLACE (C3-1).

        Seeds ONLY when the stored catalog is empty OR its
        ``rule_catalog_seed_version`` is older than ``RULE_CATALOG_SEED_VERSION``.
        A non-empty, operator-edited catalog at the current seed version is NEVER
        overwritten. Returns True if the catalog was (re)seeded."""
        if self.rule_catalog and self.rule_catalog_seed_version >= RULE_CATALOG_SEED_VERSION:
            return False
        if self.rule_catalog:
            # Catalog already has operator content — bump the version marker so we
            # don't re-evaluate every boot, but DO NOT clobber their edits. We DO heal
            # the known-broken ModSec match field: ``rule.id.keyword`` is an ES index
            # sub-field that never exists in ``_source``, so it never matched (audit #16).
            # That is unambiguously a bug, not an operator choice, so rewriting it to the
            # real ``rule.id`` path is safe and preserves every other edit.
            healed = False
            for _r in self.rule_catalog:
                if getattr(getattr(_r, "match", None), "field", "") == "rule.id.keyword":
                    _r.match.field = "rule.id"
                    healed = True
            self.rule_catalog_seed_version = RULE_CATALOG_SEED_VERSION
            return healed
        self.rule_catalog = default_rule_catalog()
        self.rule_catalog_seed_version = RULE_CATALOG_SEED_VERSION
        return True

    def model_for_rule(self, role: str, rule_value: str | None) -> ModelConfig:
        """Per-rule model selection (C3-6b).

        Precedence: (1) a matching ``RuleDefinition.model_override[role]`` for
        ``rule_value``, (2) ``rule_model_override[rule_value]``, (3) the role
        default ``model_for(role)``. Identical to ``model_for(role)`` whenever no
        per-rule override exists, so behaviour is unchanged out of the box.

        ``role`` may be a ``Role`` enum or its string value (mirrors
        ``model_for``); we key everything on its string form."""
        role_str = str(getattr(role, "value", role))
        if rule_value:
            for rd in self.rule_catalog:
                if rd.name == rule_value and role_str in rd.model_override:
                    return rd.model_override[role_str]
            override = self.rule_model_override.get(rule_value)
            if override is not None:
                return override
        return self.model_for(role_str)


# --------------------------------------------------------------------------- #
# Built-in rule catalog (C3-1) — seeded on first run only.
# --------------------------------------------------------------------------- #
# The 13 real upstream detection rules, each identified by ``event.module``.
_REAL_EVENT_MODULES: tuple[str, ...] = (
    "mail_apache_access",
    "mail_auth",
    "mail_fim",
    "ml_stats",
    "modsec_audit_log",
    "openvas_report",
    "postfix",
    "roundcube_login",
    "suricata_mail",
    "waf-nginx-access",
    "waf_auth",
    "web_apache_access",
    "web_auth",
)

# ModSecurity sub-detections, keyed by the OWASP CRS ``rule.id`` prefix. These
# get a LOWER ``priority`` than the generic ``modsec_audit_log`` rule so a ModSec
# event classifies as its specific sub-rule first, falling back to the generic.
_MODSEC_SUBRULES: tuple[tuple[str, str, str], ...] = (
    ("modsec_xss", "941", "ModSecurity OWASP CRS XSS (rule.id 941xxx)"),
    ("modsec_sqli", "942", "ModSecurity OWASP CRS SQL injection (rule.id 942xxx)"),
    ("modsec_lfi", "930", "ModSecurity OWASP CRS LFI / file inclusion (rule.id 930xxx)"),
    ("modsec_rce", "932", "ModSecurity OWASP CRS RCE (rule.id 932xxx)"),
    ("modsec_scanner", "913", "ModSecurity OWASP CRS scanner detection (rule.id 913xxx)"),
)


def default_rule_catalog() -> list[RuleDefinition]:
    """Build the pre-baked rule catalog: the 13 ``event.module`` rules plus the 5
    ModSec sub-rules. ModSec sub-rules carry a lower ``priority`` (50) than the
    generic rules (100) so they classify first; nothing here is hardcoded beyond
    seeding these real detections — operators can edit/disable/extend freely."""
    rules: list[RuleDefinition] = [
        RuleDefinition(
            name=name,
            description=f"Upstream detection '{name}' (event.module).",
            match=RuleMatch(field="event.module", op="equals", value=name),
            priority=100,
        )
        for name in _REAL_EVENT_MODULES
    ]
    rules.extend(
        RuleDefinition(
            name=name,
            description=desc,
            match=RuleMatch(field="rule.id", op="prefix", value=prefix),
            priority=50,
        )
        for name, prefix, desc in _MODSEC_SUBRULES
    )
    return rules
