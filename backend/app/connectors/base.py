"""The connector SPI — one contract every log source plugs into.

A *connector* turns some external system into a stream of normalised
:class:`OCSFEvent` / :class:`RawEvent`. There are two physical shapes, sharing a
common base so the registry, the wizard and the engine treat them uniformly:

  * :class:`PullConnector` — we drive it (poll a search API on a durable cursor,
    or run an ad-hoc structured search). Elasticsearch, OpenSearch, Splunk,
    Sentinel, QRadar, Chronicle, SentinelOne, Wazuh-indexer, Defender-hunting.
  * :class:`PushReceiver` — it drives us (we run a listener / consume a broker /
    poll an object store and events arrive asynchronously). Webhook, syslog,
    Kafka, Event Hub, Pub/Sub, SQS, Kinesis, S3, OTLP, MQTT, …

Both expose a :class:`ConnectorManifest` describing their identity, the ingest
modes they support, and — crucially — the **auth/config fields** the first-run
wizard renders so an operator can "add the SIEM they wish" with no code change.
Every connector normalises to OCSF via :meth:`Connector.to_ocsf`.

The agents/engine NEVER see source-native records — only OCSF/RawEvent.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field

from ..config import Preferences
from ..constants import IngestMode, SourceType
from ..models import Cursor, RawEvent
from ..ocsf import OCSFEvent, generic_to_ocsf

logger = logging.getLogger("tlsoc.connectors.base")


# --------------------------------------------------------------------------- #
# Wizard-facing metadata
# --------------------------------------------------------------------------- #
class AuthField(BaseModel):
    """One input the first-run wizard renders for a connector.

    ``secret`` fields are written to the secret store and surfaced in the UI as
    ``configured ✓`` only (never echoed back) — non-negotiable #10.

    CONTEXTUAL HELP (Wave 5 / F9; all additive/optional): besides the short ``help``
    tooltip text, a field may ship a ``help_link`` (a doc URL the wizard renders as a
    "Learn more" affordance), a ``help_code`` snippet (a copy-pasteable example —
    e.g. the exact ``POST /_security/api_key`` body to mint a scoped read-only key)
    and the ``help_code_language`` for that snippet. The frontend auto-chooses a
    popover over a tooltip when ``help`` is long OR a link/code is present.
    """

    key: str
    label: str
    type: str = "string"          # string|password|number|bool|select|textarea|multiselect
    required: bool = False
    secret: bool = False
    default: Any = None
    options: list[str] | None = None
    help: str = ""
    help_link: str = ""           # doc URL ("Learn more"), or ""
    help_code: str = ""           # copy-pasteable example snippet, or ""
    help_code_language: str = "yaml"  # language hint for help_code (yaml|json|bash|...)
    placeholder: str = ""
    group: str = "Connection"     # wizard section grouping


class ConnectorManifest(BaseModel):
    """Self-description of a connector (drives discovery + the wizard)."""

    source_type: SourceType
    display_name: str
    category: str = "siem"        # siem|edr_xdr|transport|queue|object_store|file
    version: str = "1.0.0"
    description: str = ""
    ingest_modes: list[IngestMode] = Field(default_factory=list)
    query_language: str = "kuery"  # native query language for provenance/deep-links
    capabilities: list[str] = Field(default_factory=list)  # poll|search|fetch_by_ids|subscribe|aggregate|test|browse
    # "browse" advertises operator log browsing (GET /api/sources/{id}/logs and the
    # /api/logs fan-out); the registry auto-augments push receivers with it.
    auth_fields: list[AuthField] = Field(default_factory=list)
    config_fields: list[AuthField] = Field(default_factory=list)
    docs_url: str | None = None
    requires_pip: list[str] = Field(default_factory=list)   # optional deps for this connector
    # A concise Markdown "how to add this source" guide (Wave 5 / F9), rendered in the
    # wizard alongside the field form. Step list: where to find the URL/credential,
    # how to scope a READ-ONLY key (never kibana_system / the elastic superuser, #1),
    # which index/topic/endpoint to point at. Additive/optional — empty by default.
    setup_help: str = ""


class ConnectionTest(BaseModel):
    """Result of a wizard 'Test connection' click."""

    ok: bool
    message: str = ""
    mode: str | None = None              # "read_only" | "full" | None
    sample_count: int | None = None
    cluster_monitor: bool | None = None  # optional extra signal — NEVER the pass/fail gate
    detail: dict[str, Any] = Field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Query IR + results (the seam that replaces pass-through ES DSL)
# --------------------------------------------------------------------------- #
class StructuredQuery(BaseModel):
    """Source-neutral query the agent's es_query tool emits.

    Each connector compiles this to its dialect (ES/OpenSearch DSL, SPL, KQL,
    AQL, UDM). The LLM never emits raw DSL — only this structured shape.
    """

    ip: str | None = None
    user: str | None = None
    host: str | None = None
    rule: str | None = None
    severity_gte: float | None = None
    contains: str | None = None
    ids: list[str] = Field(default_factory=list)
    time_from: str | None = None      # "now-24h" or ISO
    time_to: str | None = None        # "now" or ISO
    size: int = 50
    sort_desc: bool = True            # newest first for ad-hoc search


class QueryRendering(BaseModel):
    """Provenance: the native query a connector ran (for audit + UI deep-links)."""

    query: str
    language: str = "kuery"
    data_view: str = ""
    time_from: str | None = None
    time_to: str | None = None
    deep_link: str | None = None       # link into the source's own UI (optional)


class SearchResult(BaseModel):
    events: list[RawEvent] = Field(default_factory=list)
    total: int = 0
    rendering: QueryRendering | None = None
    raw: dict[str, Any] | None = None  # native response, for debugging only


# Async callback a PushReceiver invokes for each batch of normalised events.
EmitFn = Callable[[list[RawEvent]], Awaitable[None]]


# --------------------------------------------------------------------------- #
# The connector hierarchy
# --------------------------------------------------------------------------- #
class Connector(ABC):
    """Common base: identity + normalisation. Never instantiated directly."""

    source_type: SourceType

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        self.config = config or {}
        self.connector_id = connector_id or self.source_type.value

    @classmethod
    @abstractmethod
    def manifest(cls) -> ConnectorManifest:
        """Static self-description (does NOT require an instance/credentials)."""

    def to_ocsf(self, raw: dict[str, Any], prefs: Preferences) -> OCSFEvent:
        """Normalise one source-native record to OCSF.

        Default: best-effort generic mapping. Source-specific connectors override
        with a precise mapper (e.g. the Elastic connector uses ``ecs_to_ocsf``).
        """
        return generic_to_ocsf(raw, prefs, source_type=self.source_type, connector_id=self.connector_id)

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        """Validate auth/reachability for the wizard. Default: best-effort ping."""
        try:
            ok = await self.ping()  # type: ignore[attr-defined]
            return ConnectionTest(ok=bool(ok), message="OK" if ok else "unreachable")
        except Exception as exc:  # noqa: BLE001
            return ConnectionTest(ok=False, message=str(exc))

    async def close(self) -> None:  # noqa: D401 — optional resource cleanup
        return None


class PullConnector(Connector):
    """A source we POLL on a durable cursor and run ad-hoc structured searches on."""

    @abstractmethod
    async def ping(self) -> bool: ...

    @abstractmethod
    async def poll(self, prefs: Preferences, cursor: Cursor, from_millis: int) -> list[RawEvent]:
        """Return in-scope events at/after ``from_millis`` (inclusive lower bound),
        time-ascending. The poller advances the cursor and dedups; the connector
        only fetches. ``cursor`` is provided for connectors whose API needs an
        opaque continuation token (timestamp connectors can ignore it)."""

    @abstractmethod
    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        """Run a structured ad-hoc search (backs the es_query tool)."""

    @abstractmethod
    async def fetch_by_ids(self, prefs: Preferences, ids: list[str], size: int) -> SearchResult:
        """Fetch specific events by source-native id (Surface-2 row click)."""


class PushReceiver(Connector):
    """A source that PUSHES to us: an HTTP/syslog listener, a broker consumer, or
    an object-store poller. ``start`` runs until ``stop``; each normalised batch is
    delivered via the ``emit`` callback (which feeds the same correlate→risk→LLM
    pipeline the poller feeds)."""

    #: Optional durable-cursor IO, injected by AppState from the CursorStore keyed by
    #: this receiver's connector_id. Object-store / stream receivers use it to persist
    #: their last-processed marker so a restart resumes instead of losing data or
    #: re-processing from the configured start (audit #7). None → no persistence
    #: (unit tests, route-driven receivers).
    _cursor_load: Callable[[], Awaitable[Cursor]] | None = None
    _cursor_save: Callable[[Cursor], Awaitable[None]] | None = None

    def attach_cursor_io(
        self,
        *,
        load: Callable[[], Awaitable[Cursor]],
        save: Callable[[Cursor], Awaitable[None]],
    ) -> None:
        """Wire durable cursor persistence for this receiver instance."""
        self._cursor_load = load
        self._cursor_save = save

    async def load_cursor(self) -> Cursor | None:
        """Load this receiver's durable cursor (None if no IO is attached). Never raises."""
        if self._cursor_load is None:
            return None
        try:
            return await self._cursor_load()
        except Exception as exc:  # noqa: BLE001 — degrade to cold start, never crash
            logger.warning("cursor load failed for %s: %s", self.connector_id, exc)
            return None

    async def save_cursor(self, cursor: Cursor) -> None:
        """Persist this receiver's durable cursor (no-op if no IO is attached). Never raises."""
        if self._cursor_save is None:
            return
        try:
            await self._cursor_save(cursor)
        except Exception as exc:  # noqa: BLE001 — best-effort; a persist glitch must not stall
            logger.warning("cursor save failed for %s: %s", self.connector_id, exc)

    @abstractmethod
    async def start(self, emit: EmitFn, prefs: Preferences) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    def parse(self, payload: bytes | str | dict[str, Any], prefs: Preferences) -> list[RawEvent]:
        """Parse a raw pushed payload into normalised RawEvents.

        Concrete receivers override this with their transport's framing/format
        handling; the engine and tests can call it directly (no socket needed),
        which is how receivers stay unit-testable. Default: treat the payload as a
        single JSON object/record."""
        raise NotImplementedError
