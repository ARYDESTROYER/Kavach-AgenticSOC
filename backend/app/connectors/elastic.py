"""Elasticsearch / ELK pull connector.

A faithful wrapper of the suite's existing read-only Elasticsearch access. It
implements the :class:`PullConnector` SPI by REUSING the centralised query
builders (:mod:`app.es.querybuilder`) and reproducing — byte-for-byte — the
search body and KQL rendering the legacy ``es_query`` tool emits, so a later
rewire of ``app/tools/es_query.py`` and ``app/engine/poller.py`` onto this
connector is behaviour-preserving (every existing test stays green).

The connector NEVER sees source-native records leaking into the engine: it
normalises every hit to OCSF via :func:`app.ocsf.ecs_to_ocsf`, and the engine
consumes :class:`app.models.RawEvent` projections produced by
``RawEvent.from_hit`` (the same extraction path the legacy code uses).

All ES access flows through :class:`app.es.base.BaseESClient.search_logs`, which
is backed exclusively by the scoped, read-only API key (Non-negotiable #1).
"""

from __future__ import annotations

import copy
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import Field

from ..config import IndexPattern, Preferences
from ..constants import DEFAULT_SEVERITY_SCALE_MAX, IndexRole, IngestMode, SourceType
from ..es.base import BaseESClient
from ..es.querybuilder import ids_query, late_arrival_query, poll_query
from ..models import Cursor, RawEvent, make_cursor_event_key
from ..ocsf import OCSFEvent, ecs_to_ocsf, score_to_severity_id
from ..utils import dotted_get, parse_es_timestamp, relative_to_millis, to_millis
from .base import (
    AGGREGATE_INTERVALS,
    AggregateBucket,
    AggregateResult,
    AuthField,
    ConnectionTest,
    ConnectorManifest,
    PullConnector,
    QueryRendering,
    SearchResult,
    StructuredQuery,
    aggregate_field,
)

# Parity constants with ``app/tools/es_query.py`` (keep these in lock-step).
_MAX_SIZE = 200
_DEFAULT_SIZE = 50
_POLL_PIT_KEEP_ALIVE = "1m"
_MAX_FRONTIER_PAGES = 64
_MAX_LATE_PAGES = 32
# ES/OpenSearch default index.max_result_window — offset (from+size) pagination cannot
# cross it without the engine rejecting the search. The non-PIT fallback caps the drain
# here and defers the remainder to the next tick (audit #6).
_MAX_RESULT_WINDOW = 10_000

logger = logging.getLogger("tlsoc.connectors.elastic")


@dataclass
class FeedScan:
    """One feed's poll result + the watermark of EVERY hit it READ (#4 no-skip).

    ``events`` are the KEPT events (this feed's most-specific owns) — the ones the
    poller correlates/registers. ``scan_max_ts`` / ``scan_boundary_ids`` describe the
    full SCANNED window (kept AND dropped hits): the broad feed reads hits owned by a
    narrower overlapping feed and DROPS them (longest-pattern-wins), but it must still
    advance ITS OWN cursor over the whole window it scanned — otherwise the dropped
    hits' time window is passed over and the broad feed's own newer events beyond it are
    SKIPPED forever (#4). The dropped hits are independently owned + processed by the
    narrower feed via that feed's own cursor, so nothing is lost or duplicated.

    ``scan_recent_event_millis`` carries the exact identities observed in the
    bounded late-arrival window; ``overlap_backfill_complete`` prevents an upgraded
    cursor from replaying history before that ledger has been filled.  A
    ``scan_max_ts`` of zero means the feed read no hits this tick."""

    events: list[RawEvent] = field(default_factory=list)
    scan_max_ts: int = 0
    scan_boundary_ids: list[str] = field(default_factory=list)
    scan_recent_event_millis: dict[str, int] = field(default_factory=dict)
    overlap_backfill_complete: bool = False


def _http_status(exc: Exception) -> int | None:
    """Best-effort HTTP status from an ES driver exception (401/403/...), else None
    (network/TLS errors have no status). Works without importing the driver."""
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "meta", None), "status", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


_BRACKETED_RE = re.compile(r"\[([^\[\]\s]{1,256})\]")
# Round 12 (SPEC P0-5): calendar bucket widths the chat ``log_stats`` tool may ask for,
# mapped to the ``calendar_interval`` unit (Elasticsearch and OpenSearch spell them the
# same way). Everything in ``AGGREGATE_INTERVALS`` except ``1w`` stays a fixed width.
CALENDAR_INTERVALS: dict[str, str] = {"1w": "week", "1M": "month", "1q": "quarter", "1y": "year"}
# An IANA timezone name for ``date_histogram.time_zone`` (never free text).
_TZ_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_+/-]{0,63}$")


class IncompleteSearchError(RuntimeError):
    """An Elasticsearch-family search answered HTTP 200 from only part of its data (a
    failed shard or a timed-out search), so no count it carries is exact."""


def response_is_complete(resp: Any) -> bool:
    """Did a native search answer from ALL of its data?

    ``False`` when the response says it timed out or that a shard failed: with the
    default ``allow_partial_search_results`` a cluster answers HTTP 200 with the failed
    shards' hits (and their share of every total and aggregation) missing, so the
    figures are lower bounds at best. A shard the cluster SKIPPED (no document could
    match) is not a failure. A response without ``_shards`` (the in-memory backend, a
    mocked client) carries no such evidence and is complete. The rule
    ``stores.cases.check_complete_response`` applies to the suite's own state, restated
    here because a connector never imports the stores."""
    if not isinstance(resp, dict):
        return True
    if resp.get("timed_out") is True:
        return False
    shards = resp.get("_shards")
    if isinstance(shards, dict):
        try:
            failed = int(shards.get("failed") or 0)
        except (TypeError, ValueError):
            return False
        if failed > 0:
            return False
    return True


def _fields_named_in(exc: Exception, fields: Any) -> set[str]:
    """The given field names an ES 400 names in brackets ("fielddata is disabled on
    [user.name]"), searched in the message and the structured error body."""
    wanted = set(fields)
    texts = [str(exc)]
    for attr in ("info", "body"):
        value = getattr(exc, attr, None)
        if value is not None:
            texts.append(str(value))
    found: set[str] = set()
    for blob in texts:
        found.update(m for m in _BRACKETED_RE.findall(blob) if m in wanted)
    return found


# --------------------------------------------------------------------------- #
# Round 14 (SPEC §4.6.1): the exact Logs filters
# --------------------------------------------------------------------------- #
class LogFilterQuery(StructuredQuery):
    """A :class:`StructuredQuery` with the exact Logs filters of Round 14.

    The bundled Elastic-family connectors (Elasticsearch, OpenSearch, Wazuh) compile
    these natively in :meth:`ElasticConnector.search`, :meth:`ElasticConnector.aggregate`
    and :meth:`ElasticConnector.aggregate_composite`, so a filtered count and the events
    a filtered search returns describe one population. Any other connector receives an
    ordinary ``StructuredQuery`` and the caller filters its rows itself.

    * ``rule_any``: an exact (equality) match against ANY rule identity of an event: the
      source's rule field, its rule name field, or the suite rule the event is classified
      as (``Preferences.rule_catalog``, first enabled match in priority order, the
      classification :meth:`app.models.RawEvent.from_hit` applies). The Console shows a
      row's rule as one of these, a case records the classified one, and the chat's exact
      aggregation groups by the rule field, so a value taken from any of them filters to
      the events that carry it. Never a substring or analysed match.
    * ``severity_lt``: an exclusive upper bound on the raw severity field, beside the
      inherited inclusive ``severity_gte`` (both already projected through the source's
      own ceiling by :func:`app.engine.severity_levels.raw_range`).
    * ``severity_missing``: an event with no severity value also matches (it reads as
      ``0.0``, so Info). Only meaningful with ``severity_lt`` and no ``severity_gte``.

    Every read of this query also leaves out, natively, the events a search would drop
    after the fact: those whose most specific feed is an IGNORE carve-out of a broader
    live feed (:meth:`ElasticConnector.carve_out_clauses`), so a filtered total counts
    only events the rows can show.

    The rule value is untrusted log-derived text (#9): it is bound as a ``term`` value,
    never parsed as query syntax. Every rule clause is an exact-value match whatever the
    field's mapping (:func:`exact_value_clause`), never an analysed one."""

    rule_any: str | None = None
    severity_lt: float | None = None
    severity_missing: bool = False


def _num(value: float) -> str:
    """A bound as the KQL rendering prints it: integral floats without ``.0``, every
    other value exactly (``repr``), so the rendering describes the query that ran."""
    if float(value).is_integer():
        return str(int(value))
    return repr(float(value))


def _kql_text(value: Any) -> str:
    """A value inside a KQL double-quoted string (quotes and backslashes escaped)."""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


#: The exact-value sub-field Elasticsearch's default dynamic mapping adds beside every
#: string field (``text`` plus ``<field>.keyword``, OpenSearch alike).
KEYWORD_SUBFIELD = "keyword"


def exact_value_clause(field_name: str, value: str, *, kind: str = "term") -> dict[str, Any]:
    """An EXACT ``term`` (or ``prefix``) match of ``value`` on ``field_name``, whatever
    the field's mapping.

    A ``term`` query is not analysed while a ``text`` field is indexed as lower-cased
    tokens, and the default dynamic mapping makes every string field ``text`` with a
    ``.keyword`` sub-field (the reason :meth:`ElasticConnector.aggregate` retries on
    ``.keyword``). A bare ``term`` on such a field never matches a multi-word value and
    does match a single token inside other values (``ssh`` would match "SSH brute
    force"). So the clause matches the exact-value sub-field whenever a document has
    one, and the field itself only on a document without it (a ``keyword``-mapped index,
    where the field already holds exact values):

    ``(field.keyword = value) or (field = value and field.keyword does not exist)``

    A field that already names its ``.keyword`` sub-field is matched as it is. The value
    is bound as a query value, never parsed as query syntax (#9)."""
    if kind not in ("term", "prefix"):
        raise ValueError(f"unsupported exact clause kind {kind!r}")
    if field_name.endswith(f".{KEYWORD_SUBFIELD}"):
        return {kind: {field_name: value}}
    sub = f"{field_name}.{KEYWORD_SUBFIELD}"
    return {"bool": {
        "should": [
            {kind: {sub: value}},
            {"bool": {"filter": [{kind: {field_name: value}}],
                      "must_not": [{"exists": {"field": sub}}]}},
        ],
        "minimum_should_match": 1,
    }}


def _catalog_match_clause(match: Any) -> tuple[dict[str, Any], str] | None:
    """One suite rule's ``RuleMatch`` as a native clause and its KQL, or ``None`` when
    the operator is unknown. ``equals`` and ``tag`` are an exact ``term`` (an exact
    value, or a member of a list field), ``prefix`` an exact-value ``prefix`` query,
    ``exists`` a present, non-empty value (:func:`exact_value_clause`, so an analysed
    ``text`` field is matched on its ``.keyword`` sub-field as ``RuleMatch.matches``
    compares whole values)."""
    field_name = str(getattr(match, "field", "") or "")
    op = getattr(match, "op", None)
    value = getattr(match, "value", None)
    if not field_name:
        return None
    if op == "exists":
        return (
            {"bool": {"filter": [{"exists": {"field": field_name}}],
                      "must_not": [exact_value_clause(field_name, "")]}},
            f"{field_name} : *",
        )
    if value is None:
        return None
    if op in ("equals", "tag"):
        return exact_value_clause(field_name, str(value)), f'{field_name} : "{_kql_text(value)}"'
    if op == "prefix":
        return (
            exact_value_clause(field_name, str(value), kind="prefix"),
            f"{field_name} : {_kql_text(value)}*",
        )
    return None


def rule_identity_clause(prefs: Preferences, value: str) -> tuple[dict[str, Any], str]:
    """The native clause and KQL of "this event's rule is ``value``" (see
    :class:`LogFilterQuery`): an exact ``term`` on the rule field, an exact ``term`` on
    the rule name field (each through :func:`exact_value_clause`, so an analysed field
    is compared on its exact-value sub-field), and for each ENABLED suite rule named
    ``value`` its match with every rule that classifies first (lower priority, then
    catalog order) excluded, which is exactly the first-match classification
    ``RawEvent.from_hit`` applies. The KQL renders the comparison the Console and
    Discover show (``field : "value"``)."""
    should: list[dict[str, Any]] = [exact_value_clause(prefs.rule_field, value)]
    kql: list[str] = [f'{prefs.rule_field} : "{_kql_text(value)}"']
    name_field = getattr(prefs, "rule_name_field", None)
    if name_field and name_field != prefs.rule_field:
        should.append(exact_value_clause(name_field, value))
        kql.append(f'{name_field} : "{_kql_text(value)}"')
    catalog = list(getattr(prefs, "rule_catalog", None) or [])
    ordered = sorted((rd for rd in catalog if getattr(rd, "enabled", True)),
                     key=lambda rd: getattr(rd, "priority", 100))
    for position, rd in enumerate(ordered):
        if getattr(rd, "name", None) != value:
            continue
        own = _catalog_match_clause(getattr(rd, "match", None))
        if own is None:
            continue
        earlier = [c for c in (_catalog_match_clause(getattr(o, "match", None))
                               for o in ordered[:position]) if c is not None]
        if earlier:
            should.append({"bool": {"filter": [own[0]], "must_not": [c[0] for c in earlier]}})
            kql.append(f"({own[1]} and not ({' or '.join(c[1] for c in earlier)}))")
        else:
            should.append(own[0])
            kql.append(own[1])
    return {"bool": {"should": should, "minimum_should_match": 1}}, f"({' or '.join(kql)})"


def severity_upper_clause(
    field_name: str, lt: float, *, include_missing: bool,
) -> tuple[dict[str, Any], str]:
    """``field < lt`` (exclusive), optionally also an event with no value at all."""
    bounded = {"range": {field_name: {"lt": lt}}}
    kql = f"{field_name} < {_num(lt)}"
    if not include_missing:
        return bounded, kql
    missing = {"bool": {"must_not": [{"exists": {"field": field_name}}]}}
    return (
        {"bool": {"should": [bounded, missing], "minimum_should_match": 1}},
        f"({kql} or not {field_name} : *)",
    )


#: A feed pattern an ``_index`` wildcard reads exactly as ``fnmatch`` (the feed
#: attribution of :meth:`ElasticConnector._feed_for_index`) does: index-name characters
#: plus ``*`` and ``?``. A character class (``[``), an escape (``\``), a list (``,``),
#: date math (``<``) or a leading exclusion (``-``, ``+``) is read differently by the two.
_INDEX_WILDCARD_RE = re.compile(r"^[A-Za-z0-9_.:*?][A-Za-z0-9_.:*?+-]*$")


def _index_wildcard(pattern: str) -> tuple[dict[str, Any], str]:
    """An ``_index`` wildcard clause and its KQL (a ``:`` escaped, ``*`` left a wildcard)."""
    escaped = pattern.replace(":", "\\:")
    return {"wildcard": {"_index": {"value": pattern}}}, f"_index : {escaped}"


def _log_filter_clauses(prefs: Preferences, query: StructuredQuery) -> tuple[list[dict[str, Any]], list[str]]:
    """The native clauses (and KQL) of :class:`LogFilterQuery`'s extra filters; an
    ordinary ``StructuredQuery`` yields none, so every existing body is unchanged."""
    clauses: list[dict[str, Any]] = []
    kql: list[str] = []
    rule_any = getattr(query, "rule_any", None)
    if isinstance(rule_any, str) and rule_any != "":
        clause, text = rule_identity_clause(prefs, rule_any)
        clauses.append(clause)
        kql.append(text)
    lt = getattr(query, "severity_lt", None)
    if lt is not None:
        clause, text = severity_upper_clause(
            prefs.severity_field, float(lt),
            include_missing=bool(getattr(query, "severity_missing", False))
            and getattr(query, "severity_gte", None) in (None, ""),
        )
        clauses.append(clause)
        kql.append(text)
    return clauses, kql


class RankedAggregateResult(AggregateResult):
    """An :class:`AggregateResult` that also says how far a top list's counts can be off.

    A ``terms`` aggregation over more than one shard (``all-logs-*`` daily indices, so
    any window longer than a day) asks each shard for its own top values and adds up
    what came back. A value outside one shard's top list misses that shard's share, so
    a listed count can be low and an unlisted value can outrank the last listed row.
    ``error_bound`` maps each group to the backend's ``doc_count_error_upper_bound``:
    ``0`` means every listed count is exact and nothing left off can outrank the last
    row; anything else (a positive bound, or ``-1`` for "not computed") means neither
    is proven. A group the backend reported no bound for is absent (unknown), never 0.
    A list with no remainder (``other == 0``) is exact whatever its bound."""

    error_bound: dict[str, int] = Field(default_factory=dict)


# Composite aggregation (the exact two-level breakdowns of SPEC §4.7.2): page size and
# the most combinations one call collects before it stops and says so (``complete``).
COMPOSITE_PAGE_SIZE = 1000
COMPOSITE_MAX_BUCKETS = 10_000
# A fixed bucket width for ``aggregate_composite`` beside the shared vocabulary: a
# whole number of minutes, hours or days (``12h``, ``3h``, ``2d``).
_FIXED_INTERVAL_RE = re.compile(r"^[1-9][0-9]{0,3}[mhd]$")


@dataclass
class CompositeAggregate:
    """What :meth:`ElasticConnector.aggregate_composite` returns.

    ``total`` is the EXACT number of matching events. ``rows`` holds one entry per
    distinct combination: ``(keys, count)``, where ``keys`` follows the requested order
    (the time bucket first, as an ISO-8601 UTC start, when an interval was asked for).
    A ``None`` key is an event with no value for that field (``missing_bucket``), so the
    counts of a single-valued field add up to ``total``. ``complete`` is ``False`` when
    the bucket cap stopped the paging; the rows are then a lower bound and a caller must
    not present them as exact."""

    total: int = 0
    fields: list[str] = field(default_factory=list)
    interval: str | None = None
    rows: list[tuple[tuple[Any, ...], int]] = field(default_factory=list)
    complete: bool = True
    rendering: QueryRendering | None = None


class ElasticConnector(PullConnector):
    """Pull connector for Elasticsearch / the Elastic (ELK) stack.

    Wraps a :class:`BaseESClient` whose ``search_logs`` is the suite's single,
    read-only path to the log surface. Every method delegates to the existing
    query builders / OCSF mapper so behaviour is identical to the pre-connector
    code path.
    """

    source_type = SourceType.ELASTICSEARCH

    def __init__(
        self,
        es: BaseESClient,
        config: dict[str, Any] | None = None,
        connector_id: str | None = None,
    ) -> None:
        """Store the (already credential-scoped) ES client and init identity.

        ``es`` is constructed elsewhere from ``Secrets``/``Preferences`` (the
        connector does not own credentials); ``config``/``connector_id`` are the
        standard :class:`Connector` identity fields.
        """
        self._es = es
        super().__init__(config, connector_id)

    # Per-source field-mapping/scope keys that this connector's ``config`` may
    # override on top of the global Preferences (so a source whose schema differs
    # from ECS — e.g. Wazuh — reads correctly without changing global prefs).
    _OVERLAY_KEYS = (
        "data_view_pattern", "time_field", "source_ip_field", "user_field",
        "host_field", "rule_field", "rule_name_field", "severity_field",
        "severity_threshold", "in_scope_rules", "excluded_rules",
        # Deep customisability: the message column field + the entity-resolution
        # strategy can be configured per source (default = ECS / global prefs).
        "message_field", "entity_strategy",
        # The raw-record paths this source's events expose to the agent and to
        # free-text search, plus the per-event size budget for them. A source whose
        # alerts carry decision-relevant fields the ECS default does not name can
        # pin them here. An explicit ``[]`` is an operator choosing the narrow
        # identity-only projection; omitting the key inherits the global list.
        "evidence_fields", "evidence_max_chars_per_event",
    )

    # Per-source field-mapping override keys (Wave 5 / F9). Operators can pin a
    # source's schema explicitly under ``config["field_mappings_extra"]`` (a focused,
    # discoverable subset of the overlay keys — typically suggested by analyze-sample).
    # These take precedence over the top-level config keys above; both fall back to
    # the global Preferences when unset.
    _FIELD_MAPPING_EXTRA_KEYS = (
        "source_ip_field", "user_field", "host_field",
        "message_field", "severity_field", "rule_field", "rule_name_field",
        "time_field",
    )

    def _base_overrides(self) -> dict[str, Any]:
        """Source-level field-mapping/scope overrides (excludes the per-feed split).

        Precedence (highest first): ``config["field_mappings_extra"][k]`` (F9 explicit
        per-source override) → ``config[k]`` (top-level overlay) → global ``prefs``.
        This is the SOURCE layer of the effective mapping; a per-feed override
        (``feed.field_mapping`` / ``feed.message_field``) is layered ON TOP in
        :meth:`_feed_prefs`."""
        overrides = {
            k: self.config[k] for k in self._OVERLAY_KEYS
            if k in self.config and self.config[k] is not None
        }
        extra = self.config.get("field_mappings_extra")
        if isinstance(extra, dict):
            for k in self._FIELD_MAPPING_EXTRA_KEYS:
                v = extra.get(k)
                if v is not None and v != "":
                    overrides[k] = v
        return overrides

    def _effective_prefs(self, prefs: Preferences) -> Preferences:
        """Overlay this source's ``config`` field-mapping/scope keys onto ``prefs``.

        With an empty ``config`` (the default primary Elastic source) this returns
        ``prefs`` unchanged — behaviour is byte-identical to before. With a Wazuh /
        non-ECS source it yields a prefs whose field mapping + index pattern match
        that source, so poll/search/normalisation extract the right fields.

        When the source configures multiple feeds the effective ``data_view_pattern``
        becomes the comma-joined union of all NON-IGNORE feed patterns (ignore feeds
        are EXCLUDED — they are muted), so a single union search reads across every
        live feed; per-feed role/floor tagging happens on the resulting events. This
        union form backs ``search``/``fetch_by_ids``/``test_connection`` + the legacy
        ``data_view_pattern`` fallback; ``poll`` uses per-feed sub-queries (so a
        per-feed ``query``/``severity_floor`` applies)."""
        overrides = self._base_overrides()
        feeds = self._index_patterns()
        live = [f for f in feeds if f.role != IndexRole.IGNORE and f.enabled]
        if live:
            joined = ",".join(f.pattern for f in live)
            if joined:
                overrides["data_view_pattern"] = joined
        return prefs.model_copy(update=overrides) if overrides else prefs

    def _index_patterns(self) -> list[IndexPattern]:
        """The source's configured feeds (canonical, role-coerced).

        Reads ``config["index_patterns"]`` via the shared :class:`IndexPattern`
        parser so the TWO parsers (here + ``SourceInstance.index_patterns``) stay in
        lock-step. Accepts richer Feed dicts, legacy ``{pattern, role,
        auto_correlate}`` dicts and bare strings; an unknown role coerces to ``events``
        (NOT silently — the IndexRole allowlist now includes ``ignore``). Empty when
        not configured (caller uses the single ``data_view_pattern`` with role
        ``events`` — full back-compat)."""
        raw = self.config.get("index_patterns")
        out: list[IndexPattern] = []
        if isinstance(raw, list):
            for item in raw:
                try:
                    if isinstance(item, dict) and item.get("pattern"):
                        out.append(IndexPattern.model_validate(item))
                    elif isinstance(item, str) and item:
                        out.append(IndexPattern(pattern=item))
                except Exception:  # noqa: BLE001 — skip a malformed entry
                    continue
        return out

    def _poll_feeds(self) -> list[IndexPattern]:
        """The feeds ``poll`` reads — enabled, NON-ignore. Empty when the source has
        no feeds configured; ``poll`` then takes the legacy single-union path over
        ``_effective_prefs(prefs).data_view_pattern`` (byte-identical to before)."""
        return [f for f in self._index_patterns()
                if f.enabled and f.role != IndexRole.IGNORE]

    def _feed_prefs(self, prefs: Preferences, feed: IndexPattern) -> Preferences:
        """Per-feed effective prefs: source overrides + the feed's own pattern, field
        mapping and message field.

        Effective mapping = ``{**global, **source.field_mapping, **feed.field_mapping}``;
        effective message_field = ``feed.message_field or source.message_field or
        global`` — so a feed can pin its own schema while inheriting the rest."""
        overrides = self._base_overrides()
        if feed.field_mapping:
            for k, v in feed.field_mapping.items():
                if v is not None and v != "":
                    overrides[k] = v
        if feed.message_field:
            overrides["message_field"] = feed.message_field
        overrides["data_view_pattern"] = feed.pattern
        return prefs.model_copy(update=overrides)

    def _role_for_index(self, index: str) -> str:
        """Role of the configured feed an event's ``_index`` belongs to.

        Matches the event's index against each configured feed pattern (``*`` glob);
        the FIRST alerts-role feed that matches wins (so an alerts feed is honoured
        even if an events feed also matches). Ignore feeds are never read so they do
        not appear here. Defaults to ``events``."""
        import fnmatch

        feeds = self._index_patterns()
        if not feeds:
            return "events"
        for f in feeds:
            if f.role == IndexRole.ALERTS and fnmatch.fnmatch(index, f.pattern):
                return "alerts"
        return "events"

    def _feed_for_index(self, index: str) -> IndexPattern | None:
        """The most-specific configured feed an event's ``_index`` matches.

        Longest-pattern-wins precedence (a narrow ``host-secure-*`` feed beats a broad
        ``host-*`` feed) so an IGNORE sub-index carved out of a broad events feed is
        attributed to the IGNORE feed, and a per-feed ``severity_floor`` is applied
        from the right feed. Returns None when nothing matches (back-compat)."""
        import fnmatch

        best: IndexPattern | None = None
        best_len = -1
        for f in self._index_patterns():
            if f.pattern and fnmatch.fnmatch(index, f.pattern) and len(f.pattern) > best_len:
                best, best_len = f, len(f.pattern)
        return best

    def _severity_scale_max(self, prefs: Preferences | None) -> float:
        """This source's DECLARED severity-ladder ceiling, for the floor comparison.

        Resolves THIS connector's :class:`app.config.SourceInstance` out of ``prefs`` and
        returns its declared ceiling — the same one-number resolution
        :func:`app.ocsf.ecs._severity_scale` uses when it normalises the very same hit,
        so the floor gate below and the event's own OCSF ``severity_id`` are computed on
        one ladder instead of two. An unresolvable/unconfigured source resolves to the
        default ceiling (the identity projection on the canonical OCSF score), never to
        the retired ``raw <= 10 ? raw*10`` magnitude guess.

        Lazy import (``engine`` is a higher layer than ``connectors``); fail-open — a
        lookup problem degrades to the default ceiling and never breaks a poll."""
        try:
            from ..engine.priority import severity_scale_max_for_source

            source = prefs.source_by_id(self.connector_id) if prefs is not None else None
            return severity_scale_max_for_source(source)
        except Exception:  # noqa: BLE001 — a scale lookup must never break ingest
            return DEFAULT_SEVERITY_SCALE_MAX

    def _tag_events(
        self,
        events: list[RawEvent],
        feed: IndexPattern | None = None,
        prefs: Preferences | None = None,
    ) -> list[RawEvent]:
        """Stamp source/feed provenance + per-feed role + severity_floor onto events.

        ``source_id``/``source_name`` identify the originating source (UI filter).
        When ``feed`` is given (the per-feed poll path) the event is attributed to
        THAT feed; otherwise (the union search/poll path) the matching feed is resolved
        by index (longest-pattern-wins) AND an event whose most-specific feed is an
        IGNORE feed is DROPPED (a broad pattern reading an ignore carve-out is muted).
        ``index_role`` drives alerts auto-forward; ``feed_id`` records the feed;
        ``auto_investigate_eligible`` is FALSE when the event is below the feed's
        ``severity_floor`` — such an event is STILL returned (so it registers a
        candidate + live-tail) but its cluster will not auto-forward (#4, never
        dropped). All no-ops when nothing is configured.

        ``prefs`` is OPTIONAL (default ``None``) and is used only to resolve this
        source's DECLARED severity ceiling for that floor comparison — see
        :meth:`_severity_scale_max`."""
        name = self.config.get("display_name") or self.connector_id
        scale_max = self._severity_scale_max(prefs)
        out: list[RawEvent] = []
        for ev in events:
            ev.source_id = self.connector_id
            ev.source_name = name
            f = feed if feed is not None else self._feed_for_index(ev.index)
            if f is not None:
                # Union path: drop an event owned by an ignore feed (carve-out mute).
                if feed is None and f.role == IndexRole.IGNORE:
                    continue
                ev.feed_id = f.id
                ev.index_role = f.role.value if f.role != IndexRole.IGNORE else "events"
                floor = f.severity_floor
                # ``severity_floor`` is advertised as OCSF severity_id (1-6), so map the
                # RAW source severity to its OCSF severity_id before comparing (a 0..100
                # or 0..10 native severity must not be compared against a 1-6 floor).
                # The mapping goes through the source's DECLARED ceiling: without it this
                # call fell back to the retired magnitude guess, so a genuinely LOW 0..100
                # severity was x10'd over the floor (and a high native rating on a
                # declared narrow ladder was under-read) — the last unscaled
                # ``score_to_severity_id`` caller in the backend.
                # #4 preserved: below-floor only marks the event auto_investigate
                # INELIGIBLE — it is NEVER dropped (still correlated + live-tailed).
                if floor is not None and score_to_severity_id(ev.severity, scale_max) < int(floor):
                    ev.auto_investigate_eligible = False
            else:
                ev.index_role = self._role_for_index(ev.index)
            out.append(ev)
        return out

    def carve_out_clauses(self) -> tuple[list[dict[str, Any]], list[str], bool]:
        """The native clauses (and KQL) that leave out every event the union search path
        drops after the fact (:meth:`_tag_events`): an event whose most specific feed
        (:meth:`_feed_for_index`: the longest matching pattern, the earlier feed on a tie,
        enabled or not) is an IGNORE feed.

        For each IGNORE feed ``F`` the clause is "not (``_index`` matches ``F`` and no
        feed that would win over ``F`` matches)", where a winner is a longer pattern or
        an equally long one listed earlier. A muted winner has its own clause, so the
        union excludes exactly the events whose best feed is muted, and a filtered total
        counts only events the rows can show.

        The third value is ``False`` when a pattern involved is not one an ``_index``
        wildcard reads as ``fnmatch`` does (:data:`_INDEX_WILDCARD_RE`); no clause is
        built then, and a caller must not present a native total as exact. No IGNORE
        feed: no clause, exact."""
        feeds = [f for f in self._index_patterns() if f.pattern]
        clauses: list[dict[str, Any]] = []
        kql: list[str] = []
        for position, feed in enumerate(feeds):
            if feed.role != IndexRole.IGNORE:
                continue
            winners = [
                other.pattern for index, other in enumerate(feeds)
                if len(other.pattern) > len(feed.pattern)
                or (len(other.pattern) == len(feed.pattern) and index < position)
            ]
            if not all(_INDEX_WILDCARD_RE.match(p) for p in (feed.pattern, *winners)):
                return [], [], False
            owned, owned_kql = _index_wildcard(feed.pattern)
            if winners:
                kept = [_index_wildcard(p) for p in dict.fromkeys(winners)]
                clauses.append({"bool": {"must_not": [{"bool": {
                    "filter": [owned], "must_not": [clause for clause, _text in kept],
                }}]}})
                kql.append(f"not ({owned_kql} and not ({' or '.join(text for _clause, text in kept)}))")
            else:
                clauses.append({"bool": {"must_not": [owned]}})
                kql.append(f"not {owned_kql}")
        return clauses, kql, True

    def carve_outs_native(self) -> bool:
        """Every IGNORE carve-out of this source is left out natively by a filtered read
        (:meth:`carve_out_clauses`), so its native totals count only events it shows."""
        return self.carve_out_clauses()[2]

    def _log_filter_extra(
        self, prefs: Preferences, query: StructuredQuery,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """A :class:`LogFilterQuery`'s native clauses: its rule and level filters and the
        carve-out mute. An ordinary ``StructuredQuery`` yields none, so every existing
        body is unchanged."""
        clauses, kql = _log_filter_clauses(prefs, query)
        if isinstance(query, LogFilterQuery):
            mute, mute_kql, _native = self.carve_out_clauses()
            clauses.extend(mute)
            kql.extend(mute_kql)
        return clauses, kql

    # --------------------------------------------------------------------- #
    # Wizard-facing self-description
    # --------------------------------------------------------------------- #
    @classmethod
    def manifest(cls) -> ConnectorManifest:
        """Static, credential-free self-description driving discovery + wizard.

        Exposes EVERY field the first-run wizard needs to configure an Elastic
        source: connection/auth in ``auth_fields`` (secrets flagged so the UI
        only ever shows ``configured ✓``), and the operator field mapping in
        ``config_fields`` (all defaulting to ECS so a stock ELK deployment needs
        no field edits).
        """
        return ConnectorManifest(
            source_type=cls.source_type,
            display_name="Elasticsearch / ELK",
            category="siem",
            description=(
                "Poll a read-only, scoped Elasticsearch log index pattern on a "
                "durable cursor and run ad-hoc structured searches. Reads only; "
                "the upstream pipeline is never modified."
            ),
            ingest_modes=[IngestMode.PULL],
            query_language="kuery",
            capabilities=["poll", "search", "fetch_by_ids", "test", "browse"],
            docs_url="https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api-create-api-key.html",
            setup_help=(
                "## Connect Elasticsearch (read-only)\n"
                "1. **URL** — the Elasticsearch HTTP API base URL (e.g. "
                "`https://elasticsearch:9200`). On the deploy network use the container "
                "name.\n"
                "2. **Create a READ-ONLY, scoped API key** — never use `kibana_system` "
                "or the `elastic` superuser (non-negotiable #1). In Kibana Dev Tools run "
                "the snippet on the API-key field: it grants ONLY `read` on your log "
                "index pattern.\n"
                "3. **Index pattern** — set the data view the agent reads (e.g. "
                "`all-logs-*`). Comma-separated patterns are allowed.\n"
                "4. **CA cert** — paste the PEM (or a mounted path) if your cluster uses "
                "a private CA; leave blank for a public CA.\n"
                "5. **Test connection** — a correctly-scoped read-only key verifies via a "
                "cheap scoped read (it cannot do cluster monitor — that's expected)."
            ),
            auth_fields=[
                AuthField(
                    key="es_url",
                    label="Elasticsearch URL",
                    type="string",
                    required=True,
                    placeholder="https://elasticsearch:9200",
                    help=(
                        "Base URL of the Elasticsearch HTTP API. Use the in-cluster "
                        "container name on the deploy network (e.g. "
                        "https://elasticsearch:9200)."
                    ),
                    help_link="https://www.elastic.co/guide/en/elasticsearch/reference/current/rest-apis.html",
                    group="Connection",
                ),
                AuthField(
                    key="es_api_key",
                    label="API key (read-only)",
                    type="password",
                    secret=True,
                    help=(
                        "A READ-ONLY API key scoped to the log index pattern only "
                        "(never kibana_system or the elastic superuser). Stored in "
                        "the secret store; shown only as configured."
                    ),
                    help_link="https://www.elastic.co/guide/en/elasticsearch/reference/current/security-api-create-api-key.html",
                    help_code=(
                        "POST /_security/api_key\n"
                        "{\n"
                        '  "name": "tlsoc-readonly",\n'
                        '  "role_descriptors": {\n'
                        '    "tlsoc_ro": {\n'
                        '      "cluster": [],\n'
                        '      "indices": [\n'
                        '        { "names": ["all-logs-*"], "privileges": ["read", "view_index_metadata"] }\n'
                        "      ]\n"
                        "    }\n"
                        "  }\n"
                        "}"
                    ),
                    help_code_language="json",
                    group="Connection",
                ),
                AuthField(
                    key="es_ca_cert",
                    label="CA certificate (PEM)",
                    type="textarea",
                    help=(
                        "PEM-encoded CA certificate (or a path mounted into the "
                        "container, e.g. /certs/ca/ca.crt) used to verify the TLS "
                        "connection to Elasticsearch. Leave blank for a public CA."
                    ),
                    group="Connection",
                ),
                AuthField(
                    key="es_verify_certs",
                    label="Verify TLS certificates",
                    type="bool",
                    default=True,
                    help=(
                        "Verify the Elasticsearch server certificate against the CA. "
                        "Disable ONLY for a throwaway lab with self-signed certs."
                    ),
                    group="Connection",
                ),
            ],
            config_fields=[
                AuthField(
                    key="data_view_pattern",
                    label="Log index pattern",
                    type="string",
                    required=True,
                    default="all-logs-*",
                    placeholder="all-logs-*",
                    help=(
                        "The index pattern / data view the agent reads (read-only). "
                        "Comma-separated patterns are allowed (e.g. "
                        "'fosstlsoc-logs-*,all-logs-*')."
                    ),
                    help_link="https://www.elastic.co/guide/en/kibana/current/data-views.html",
                    group="Field mapping",
                ),
                AuthField(
                    key="time_field",
                    label="Timestamp field",
                    type="string",
                    default="@timestamp",
                    help="Event time field. Drives the durable cursor and sorting.",
                    group="Field mapping",
                ),
                AuthField(
                    key="source_ip_field",
                    label="Source IP field",
                    type="string",
                    default="source.ip",
                    help="Field holding the source/client IP used for correlation.",
                    group="Field mapping",
                ),
                AuthField(
                    key="user_field",
                    label="User field",
                    type="string",
                    default="user.name",
                    help="Field holding the acting user/account name.",
                    group="Field mapping",
                ),
                AuthField(
                    key="host_field",
                    label="Host field",
                    type="string",
                    default="host.name",
                    help="Field holding the affected host/asset name.",
                    group="Field mapping",
                ),
                AuthField(
                    key="rule_field",
                    label="Rule / module field",
                    type="string",
                    default="event.module",
                    help=(
                        "Per-event rule identity used for scope, correlation and "
                        "the auto-forward allowlist (e.g. event.module)."
                    ),
                    group="Field mapping",
                ),
                AuthField(
                    key="rule_name_field",
                    label="Rule name field",
                    type="string",
                    default="rule.name",
                    help="Human-readable detection/rule name shown in findings.",
                    group="Field mapping",
                ),
                AuthField(
                    key="severity_field",
                    label="Severity field",
                    type="string",
                    default="event.severity",
                    help=(
                        "Numeric severity field. Layer-1 of the cost gate filters "
                        "below-threshold events at query time."
                    ),
                    group="Field mapping",
                ),
            ],
        )

    # --------------------------------------------------------------------- #
    # PullConnector SPI
    # --------------------------------------------------------------------- #
    async def ping(self) -> bool:
        """Health probe — delegates to the underlying ES client."""
        return await self._es.ping()

    async def _drain_pages(
        self,
        index: str,
        base_body: dict[str, Any],
        *,
        time_field: str,
        max_pages: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        """Drain a bounded search window, preferring PIT + ``search_after``.

        PIT supplies the stable per-document ``_shard_doc`` tie-breaker required
        when many records share one timestamp.  Older OpenSearch/Wazuh-compatible
        endpoints can decline/fail PIT; those use bounded offset pagination and the
        final result is sorted deterministically client-side.  The compatibility
        path is intentionally not described as exactly-once under concurrent index
        refreshes; the durable inclusive cursor and case idempotency remain the
        recovery backstops.
        """
        size = max(1, int(base_body.get("size", 1) or 1))
        open_pit = getattr(self._es, "open_log_pit", None)
        pit_id: str | None = None
        if open_pit is not None:
            try:
                pit_id = await open_pit(index, _POLL_PIT_KEEP_ALIVE)
            except Exception as exc:  # noqa: BLE001 — compatibility fallback
                logger.debug("PIT unavailable for %s; using bounded paging: %s", index, exc)

        if pit_id:
            current_pit = pit_id
            try:
                hits: list[dict[str, Any]] = []
                search_after: list[Any] | None = None
                for _page in range(max_pages):
                    body = copy.deepcopy(base_body)
                    body.pop("from", None)
                    body["pit"] = {"id": current_pit, "keep_alive": _POLL_PIT_KEEP_ALIVE}
                    body["sort"] = [
                        {time_field: {"order": "asc"}},
                        {"_shard_doc": {"order": "asc"}},
                    ]
                    if search_after is not None:
                        body["search_after"] = search_after
                    resp = await self._es.search_logs(index, body)
                    page_hits = list(resp.get("hits", {}).get("hits", []) or [])
                    hits.extend(page_hits)
                    refreshed_pit = resp.get("pit_id")
                    if refreshed_pit:
                        current_pit = str(refreshed_pit)
                    if len(page_hits) < size:
                        return self._stable_hits(hits, time_field), False
                    marker = page_hits[-1].get("sort")
                    if not isinstance(marker, list) or marker == search_after:
                        raise RuntimeError("PIT search did not return a progressing sort token")
                    search_after = list(marker)
                return self._stable_hits(hits, time_field), True
            except Exception as exc:  # noqa: BLE001 — older compatible engines
                logger.warning("PIT pagination failed for %s; retrying compatibly: %s", index, exc)
            finally:
                close_pit = getattr(self._es, "close_log_pit", None)
                if close_pit is not None:
                    try:
                        await close_pit(current_pit)
                    except Exception as exc:  # noqa: BLE001 — best-effort cleanup
                        logger.debug("PIT close failed for %s: %s", index, exc)

        # Compatibility fallback: a bounded, oldest-first offset drain.  This path
        # is used only when PIT is unavailable; it still fixes single-page loss and
        # equal-timestamp starvation for a quiescent search view.
        #
        # ``from + size`` must stay <= the engine's ``max_result_window`` (default
        # 10_000) or ES/OpenSearch REJECTS the search — which, un-handled, would raise
        # out of the poll and permanently STALL a busy Wazuh/OpenSearch feed (audit #6).
        # So we cap the offset before crossing the window, and wrap each page so a
        # result-window / transient error TRUNCATES gracefully: we return what we read
        # (``truncated=True``) and the caller advances the durable inclusive cursor over
        # those hits, backfilling the remainder on the next tick — progress, never a stall.
        hits = []
        for page in range(max_pages):
            frm = page * size
            if frm + size > _MAX_RESULT_WINDOW:
                logger.debug(
                    "offset paging for %s stops at from=%d (max_result_window=%d); "
                    "remainder backfills next tick", index, frm, _MAX_RESULT_WINDOW,
                )
                return self._stable_hits(hits, time_field), True
            body = copy.deepcopy(base_body)
            body.pop("pit", None)
            body.pop("search_after", None)
            body["from"] = frm
            try:
                resp = await self._es.search_logs(index, body)
            except Exception as exc:  # noqa: BLE001 — window/transient error → truncate, don't stall
                logger.warning(
                    "offset paging for %s stopped at from=%d (%s); truncating this tick",
                    index, frm, exc,
                )
                return self._stable_hits(hits, time_field), True
            page_hits = list(resp.get("hits", {}).get("hits", []) or [])
            hits.extend(page_hits)
            if len(page_hits) < size:
                return self._stable_hits(hits, time_field), False
        return self._stable_hits(hits, time_field), True

    @staticmethod
    def _stable_hits(hits: list[dict[str, Any]], time_field: str) -> list[dict[str, Any]]:
        """Deduplicate and deterministically order hits by time, index and id."""
        unique: dict[str, dict[str, Any]] = {}
        for hit in hits:
            key = make_cursor_event_key(str(hit.get("_index", "")), str(hit.get("_id", "")))
            unique.setdefault(key, hit)

        def key(hit: dict[str, Any]) -> tuple[int, str, str]:
            ts = parse_es_timestamp(dotted_get(hit.get("_source", {}) or {}, time_field))
            return (
                to_millis(ts) if ts else 0,
                str(hit.get("_index", "")),
                str(hit.get("_id", "")),
            )

        return sorted(unique.values(), key=key)

    async def _collect_poll_hits(
        self,
        prefs: Preferences,
        cursor: Cursor,
        from_millis: int,
        *,
        feed: IndexPattern | None = None,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool]:
        """Return frontier hits, late-window hits, and late backfill completeness."""
        frontier_body = poll_query(prefs, cursor, from_millis)
        if feed is not None:
            self._apply_feed_query(frontier_body, feed)
        frontier, _frontier_truncated = await self._drain_pages(
            prefs.data_view_pattern,
            frontier_body,
            time_field=prefs.time_field,
            max_pages=_MAX_FRONTIER_PAGES,
        )

        late: list[dict[str, Any]] = []
        late_complete = True
        late_body = late_arrival_query(prefs, cursor)
        if late_body is not None:
            if feed is not None:
                self._apply_feed_query(late_body, feed)
            late, late_truncated = await self._drain_pages(
                prefs.data_view_pattern,
                late_body,
                time_field=prefs.time_field,
                max_pages=_MAX_LATE_PAGES,
            )
            late_complete = not late_truncated
        return frontier, late, late_complete

    async def poll_scan(
        self, prefs: Preferences, cursor: Cursor, from_millis: int
    ) -> FeedScan:
        """Drain the legacy/un-fed source and return cursor bookkeeping metadata."""
        fp = self._effective_prefs(prefs)
        frontier, late, late_complete = await self._collect_poll_hits(
            fp, cursor, from_millis
        )
        observed = self._stable_hits(frontier + late, fp.time_field)
        emitted = frontier + (late if cursor.overlap_initialized else [])
        events = self._tag_events([RawEvent.from_hit(h, fp) for h in emitted], prefs=fp)
        events.sort(key=lambda event: (event.timestamp_millis, event.index, event.id))
        scan_max_ts, scan_boundary = self._scan_watermark(observed, fp)
        return FeedScan(
            events=events,
            scan_max_ts=scan_max_ts,
            scan_boundary_ids=scan_boundary,
            scan_recent_event_millis=self._scan_recent_event_millis(observed, fp),
            overlap_backfill_complete=late_complete,
        )

    async def poll(
        self, prefs: Preferences, cursor: Cursor, from_millis: int
    ) -> list[RawEvent]:
        """Fetch bounded in-scope polling pages at/after the cursor (oldest first).

        Splits the read into PER-FEED sub-queries (Wave 6) so each feed's own
        ``query`` (a connector-native, operator-TRUSTED filter) and ``severity_floor``
        apply, and each event is attributed to its feed. For a legacy/un-fed source
        this is ONE sub-query over ``data_view_pattern`` — byte-identical to before
        (same ``poll_query`` body, same ``from_hit`` projection, same oldest-first
        sort). IGNORE feeds are excluded (muted); a below-floor event is still
        returned (NEVER dropped) but flagged ``auto_investigate_eligible=False``.

        The poller owns cursor advancement + dedup — the connector only fetches. The
        ``cursor``/``from_millis`` lower bound is applied IDENTICALLY to every feed's
        body so a single shared cursor (a feed group of equal interval) never skips."""
        feeds = self._poll_feeds()
        if not feeds:
            return (await self.poll_scan(prefs, cursor, from_millis)).events
        out: list[RawEvent] = []
        for feed in feeds:
            out.extend(await self.poll_feed(prefs, feed, cursor, from_millis))
        return sorted(out, key=lambda event: (event.timestamp_millis, event.index, event.id))

    def feeds(self) -> list[IndexPattern]:
        """The enabled, NON-ignore feeds this connector polls (Wave 6).

        The poller iterates these to drive a PER-FEED durable cursor (so a fast alerts
        feed and a slow events feed never share/skip a cursor, #4). Empty for a
        legacy/un-fed source — the poller then takes the single-cursor union path,
        byte-identical to before."""
        return self._poll_feeds()

    async def poll_feed(
        self, prefs: Preferences, feed: IndexPattern, cursor: Cursor, from_millis: int
    ) -> list[RawEvent]:
        """Fetch one in-scope polling batch FOR A SINGLE FEED (oldest first).

        Returns only the KEPT events (this feed's most-specific owns). Backs ``poll``
        (the union wrapper). The poller uses :meth:`poll_feed_scan` instead so it can
        advance the cursor over the FULL scanned window (#4 — see :class:`FeedScan`)."""
        return (await self.poll_feed_scan(prefs, feed, cursor, from_millis)).events

    async def poll_feed_scan(
        self, prefs: Preferences, feed: IndexPattern, cursor: Cursor, from_millis: int
    ) -> FeedScan:
        """Fetch one in-scope polling batch FOR A SINGLE FEED (oldest first) + the
        full-scan watermark.

        The feed's own pattern + field mapping + message field + ``query`` +
        ``severity_floor`` apply; each KEPT event is attributed to ``feed``. Backs the
        poller's per-feed cursor loop.

        A hit is KEPT only when THIS feed is its longest-pattern ("most specific")
        owner — so when a broad events feed (``logs-host-*``) overlaps a narrower
        IGNORE/ALERTS feed (``logs-host-noise*`` / ``logs-host-alerts*``), the sub-index
        is read by the broad feed but DROPPED here (it belongs to the narrower feed),
        and no event is ever read/processed twice. With a single feed (or no overlap)
        every hit is kept.

        CRITICAL (#4 no-skip): the returned :class:`FeedScan` also carries the watermark
        of EVERY hit READ (kept AND dropped), so the poller advances THIS feed's cursor
        over the whole window it scanned — never passing over (skipping) the dropped
        hits' window. The dropped hits remain owned + independently processed by the
        narrower feed via that feed's own cursor (no skip, no dup)."""
        fp = self._feed_prefs(prefs, feed)
        frontier, late, late_complete = await self._collect_poll_hits(
            fp, cursor, from_millis, feed=feed
        )
        hits = self._stable_hits(frontier + late, fp.time_field)
        # Watermark over ALL scanned hits (kept + dropped) using the feed's own time
        # field (same projection ``from_hit`` uses), so a dropped narrower-feed hit at
        # the trailing edge still moves THIS feed's cursor and is never skipped.
        scan_max_ts, scan_boundary = self._scan_watermark(hits, fp)
        emitted = frontier + (late if cursor.overlap_initialized else [])
        kept = [h for h in emitted if self._owns_index(feed, str(h.get("_index", "")))]
        events = self._tag_events([RawEvent.from_hit(h, fp) for h in kept], feed=feed, prefs=fp)
        events.sort(key=lambda event: (event.timestamp_millis, event.index, event.id))
        return FeedScan(
            events=events,
            scan_max_ts=scan_max_ts,
            scan_boundary_ids=scan_boundary,
            scan_recent_event_millis=self._scan_recent_event_millis(hits, fp),
            overlap_backfill_complete=late_complete,
        )

    @staticmethod
    def _scan_watermark(hits: list[dict[str, Any]], fp: Preferences) -> tuple[int, list[str]]:
        """Max timestamp + the ids of EVERY hit at that timestamp, over ALL scanned
        hits (kept or dropped). Mirrors the cursor's ``(max_ts, boundary_ids)`` shape
        and ``advance_cursor`` tiebreaker so the poller can advance the feed's cursor
        without skipping a same-millisecond tie. Returns ``(0, [])`` for no hits."""
        max_ts = 0
        ts_by_id: list[tuple[int, str]] = []
        for h in hits:
            ts = parse_es_timestamp(dotted_get(h.get("_source", {}) or {}, fp.time_field))
            tms = to_millis(ts) if ts else 0
            if tms <= 0:
                continue
            ts_by_id.append(
                (
                    tms,
                    make_cursor_event_key(
                        str(h.get("_index", "")), str(h.get("_id", ""))
                    ),
                )
            )
            if tms > max_ts:
                max_ts = tms
        if max_ts <= 0:
            return 0, []
        boundary = list(dict.fromkeys(i for t, i in ts_by_id if t == max_ts))
        return max_ts, boundary

    @staticmethod
    def _scan_recent_event_millis(
        hits: list[dict[str, Any]], fp: Preferences
    ) -> dict[str, int]:
        """Stable cursor-key → timestamp map for every hit observed in the scan."""
        recent: dict[str, int] = {}
        for hit in hits:
            ts = parse_es_timestamp(dotted_get(hit.get("_source", {}) or {}, fp.time_field))
            tms = to_millis(ts) if ts else 0
            if tms <= 0:
                continue
            key = make_cursor_event_key(
                str(hit.get("_index", "")), str(hit.get("_id", ""))
            )
            recent[key] = tms
        return recent

    def _owns_index(self, feed: IndexPattern, index: str) -> bool:
        """True when ``feed`` is the most-specific (longest-pattern) feed matching
        ``index`` — i.e. this feed OWNS the index (longest-pattern-wins). Used to
        partition overlapping feed reads so an index is read exactly once and an
        IGNORE carve-out of a broad pattern is attributed to (and dropped by) the
        ignore feed. True when no other feed matches (single-feed / no overlap)."""
        owner = self._feed_for_index(index)
        return owner is None or owner.id == feed.id

    @staticmethod
    def _apply_feed_query(body: dict[str, Any], feed: IndexPattern) -> None:
        """Append the feed's operator-authored ``query`` as a connector-native filter.

        The query is OPERATOR config (TRUSTED, #9 — not log-derived; still never
        interpolated into a prompt). It is added as a ``query_string`` filter so a
        broad feed pattern can be narrowed per feed (e.g. ``event.category:network``).
        Best-effort: a blank query is a no-op (the body is unchanged)."""
        q = (feed.query or "").strip()
        if not q:
            return
        flt = body.setdefault("query", {}).setdefault("bool", {}).setdefault("filter", [])
        flt.append({"query_string": {"query": q}})

    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        """Run a structured ad-hoc search (backs the ``es_query`` tool).

        Builds the SAME ES body and KQL rendering as ``app/tools/es_query.py``:
        term filters for ip/user/host/rule via the configured field names, a
        ``severity_field >= severity_gte`` range, a lenient ``contains``
        ``multi_match`` over ``prefs.free_text_search_fields()`` (the four original
        fields — ``[rule_name_field, message, event.original, event.action]`` — plus
        the configured message field and every searchable case-evidence path, so a
        field the agent is SHOWN is a field it can then SEARCH for; see
        ``app/evidence_fields.py``), and a time range (``gte``/``lte`` epoch millis),
        sorted descending on the time field, size capped at 200 (default 50). An
        ``ids`` query short-circuits to ``fetch_by_ids`` parity. The empty-filter
        case renders KQL ``"*"``; the rendering otherwise names every field the
        ``multi_match`` covered, and that same list is reported on the result as
        ``QueryRendering.fields_searched``.
        """
        prefs = self._effective_prefs(prefs)
        size = min(int(query.size or _DEFAULT_SIZE), _MAX_SIZE)

        # ids short-circuit — identical to es_query's `if ids:` branch.
        if query.ids:
            return await self.fetch_by_ids(prefs, list(query.ids), size=size)

        filters: list[dict[str, Any]] = []
        kql_parts: list[str] = []
        for val, field in (
            (query.ip, prefs.source_ip_field),
            (query.user, prefs.user_field),
            (query.host, prefs.host_field),
            (query.rule, prefs.rule_field),
        ):
            if val not in (None, ""):
                filters.append({"term": {field: val}})
                kql_parts.append(f'{field} : "{val}"')

        sev = query.severity_gte
        if sev not in (None, ""):
            filters.append({"range": {prefs.severity_field: {"gte": sev}}})
            kql_parts.append(f"{prefs.severity_field} >= {sev}")
        # Round 14 (SPEC §4.6.1): the exact rule and severity-level filters of a
        # ``LogFilterQuery`` and its carve-out mute (none for an ordinary query).
        extra_filters, extra_kql = self._log_filter_extra(prefs, query)
        filters.extend(extra_filters)
        kql_parts.extend(extra_kql)

        contains = query.contains
        searched: list[str] = []
        if contains:
            # The free-text field list is the SAME shared definition that decides what
            # the model is shown per event (``app/evidence_fields.py``). It used to be
            # four hardcoded fields that no evidence field was ever added to, so an
            # agent that suspected a missing URL ran ``contains:"http"``, got zero hits
            # from fields that could not have matched, and recorded that zero as
            # evidence the context did not exist. The four originals stay first and in
            # order, so an existing deployment's result set only ever grows.
            searched = prefs.free_text_search_fields()
            # ``lenient`` is REQUIRED, not a nicety. The evidence field list carries
            # typed ECS fields — ``http.response.status_code`` is a ``long`` and
            # ``destination.ip`` is an ``ip`` — and a non-lenient ``multi_match``
            # asks every listed field to parse the free text. On a real cluster the
            # shard then raises ``number_format_exception`` and the WHOLE search
            # fails, so widening the list without this would turn every free-text
            # query into a hard error. With it, a field that cannot parse the text
            # simply does not match. (The in-memory fake stringifies every value, so
            # it cannot reproduce that failure — the flag is asserted structurally in
            # tests/test_evidence_fields.py instead.)
            filters.append(
                {"multi_match": {"query": contains, "fields": searched, "lenient": True}}
            )
            # Render every field the multi_match actually covers rather than naming
            # ``message`` alone: this string is the operator's Discover deep-link and
            # the audited ``query_text``, and a rendering that describes a different
            # query from the one that ran is how an agent's result and a human's
            # verification silently disagree.
            #
            # No ``*`` wildcards, deliberately. The old rendering said
            # ``message : "*carol*"`` while the executed query was an ANALYSED
            # ``multi_match`` — a term match, never a substring scan. KQL
            # ``field : "value"`` compiles to exactly that match, so dropping the
            # wildcards makes the rendering a faithful description of what ran for
            # the first time, instead of promising a substring search nothing performs.
            clause = " or ".join(f'{field} : "{contains}"' for field in searched)
            kql_parts.append(f"({clause})" if len(searched) > 1 else clause)

        time_from = query.time_from if query.time_from is not None else "now-24h"
        time_to = query.time_to if query.time_to is not None else "now"
        from_millis = relative_to_millis(time_from)
        to_millis = relative_to_millis(time_to)
        filters.append(
            {"range": {prefs.time_field: {"gte": from_millis, "lte": to_millis, "format": "epoch_millis"}}}
        )

        order = "desc" if query.sort_desc else "asc"
        body: dict[str, Any] = {
            "size": size,
            "sort": [{prefs.time_field: {"order": order}}],
            "query": {"bool": {"filter": filters}},
        }
        if isinstance(query, LogFilterQuery):
            # Round 14 (SPEC §4.6.6): a filtered Logs read states its match total, so
            # the total must be exact past the default 10,000-hit tracking bound (the
            # rule summary's composite count is), never a capped "gte" figure.
            body["track_total_hits"] = True
        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        kql = " and ".join(kql_parts) if kql_parts else "*"
        return self._to_result(resp, prefs, kql, time_from, time_to, fields_searched=searched)

    async def fetch_by_ids(
        self, prefs: Preferences, ids: list[str], size: int
    ) -> SearchResult:
        """Fetch specific events by document id (Surface-2 row click).

        Mirrors ``es_query``'s ids branch: an ``ids_query`` body and the KQL
        rendering ``_id in ("a", "b")`` with no time bounds.
        """
        prefs = self._effective_prefs(prefs)
        body = ids_query(list(ids), size=size)
        kql = "_id in (%s)" % ", ".join(f'"{i}"' for i in ids)
        resp = await self._es.search_logs(prefs.data_view_pattern, body)
        return self._to_result(resp, prefs, kql, None, None)

    # --------------------------------------------------------------------- #
    # Exact aggregation (chat revamp SPEC §5.3; inherited by OpenSearch + Wazuh)
    # --------------------------------------------------------------------- #
    def _aggregate_filters(
        self, prefs: Preferences, query: StructuredQuery
    ) -> tuple[list[dict[str, Any]], str, str, str]:
        """The filter list + KQL rendering for an aggregation over ``query``.

        Deliberately the SAME clauses :meth:`search` builds (term filters on the
        mapped fields, the ``severity_gte`` range, the Round 14 rule and level filters
        and carve-out mute of a :class:`LogFilterQuery`, the lenient free-text
        ``multi_match`` over
        ``prefs.free_text_search_fields()`` and the epoch-millis time range), so an
        exact count and the events a search returns describe one population.
        ``tests/test_chat_tools_aggregate.py`` and ``tests/test_logs_rule_filter.py``
        pin the two against each other; change them together."""
        filters: list[dict[str, Any]] = []
        kql_parts: list[str] = []
        for val, fld in (
            (query.ip, prefs.source_ip_field),
            (query.user, prefs.user_field),
            (query.host, prefs.host_field),
            (query.rule, prefs.rule_field),
        ):
            if val not in (None, ""):
                filters.append({"term": {fld: val}})
                kql_parts.append(f'{fld} : "{val}"')
        sev = query.severity_gte
        if sev not in (None, ""):
            filters.append({"range": {prefs.severity_field: {"gte": sev}}})
            kql_parts.append(f"{prefs.severity_field} >= {sev}")
        extra_filters, extra_kql = self._log_filter_extra(prefs, query)
        filters.extend(extra_filters)
        kql_parts.extend(extra_kql)
        if query.contains:
            searched = prefs.free_text_search_fields()
            filters.append(
                {"multi_match": {"query": query.contains, "fields": searched, "lenient": True}}
            )
            clause = " or ".join(f'{fld} : "{query.contains}"' for fld in searched)
            kql_parts.append(f"({clause})" if len(searched) > 1 else clause)
        time_from = query.time_from if query.time_from is not None else "now-24h"
        time_to = query.time_to if query.time_to is not None else "now"
        filters.append({
            "range": {prefs.time_field: {
                "gte": relative_to_millis(time_from),
                "lte": relative_to_millis(time_to),
                "format": "epoch_millis",
            }}
        })
        kql = " and ".join(kql_parts) if kql_parts else "*"
        return filters, kql, time_from, time_to

    @staticmethod
    def _histogram(time_field: str, interval: str, time_zone: str | None) -> dict[str, Any]:
        """The ``date_histogram`` for one bucket width: a CALENDAR week, month,
        quarter or year (``1w``/``1M``/``1q``/``1y``, Round 12 SPEC P0-5) is a
        ``calendar_interval`` cut in ``time_zone`` (the operator timezone; ISO weeks
        start on Monday), so "March" means the local month; anything shorter is a
        ``fixed_interval`` in UTC, as before. A DAY (``1d``) in a zone other than UTC
        is a calendar day in that zone too (local midnight to midnight, DST-safe), so a
        daily series sums into the zone's weeks and months; in UTC the fixed and the
        calendar day are the same, so the body is unchanged. OpenSearch (and Wazuh,
        through it) accepts the same body."""
        unit = CALENDAR_INTERVALS.get(interval)
        if unit is None and interval == "1d" and time_zone and time_zone != "UTC":
            unit = "day"
        if unit is not None:
            spec: dict[str, Any] = {"field": time_field, "calendar_interval": unit}
            if time_zone and time_zone != "UTC":
                spec["time_zone"] = time_zone
            return spec
        return {"field": time_field, "fixed_interval": interval}

    @staticmethod
    def _aggregate_body(
        filters: list[dict[str, Any]],
        fields: dict[str, str],
        *,
        time_field: str,
        interval: str | None,
        top_n: int,
        time_zone: str | None = None,
    ) -> dict[str, Any]:
        """``size: 0`` body: one ``terms`` + ``cardinality`` per group field, an
        optional ``date_histogram``, and the over-time split of the FIRST group's top
        values (the heatmap matrix) as a sub-aggregation."""
        aggs: dict[str, Any] = {}
        histogram: dict[str, Any] | None = None
        if interval:
            histogram = ElasticConnector._histogram(time_field, interval, time_zone)
            aggs["over_time"] = {"date_histogram": {**histogram, "min_doc_count": 0}}
        for index, (logical, physical) in enumerate(fields.items()):
            terms: dict[str, Any] = {"terms": {"field": physical, "size": top_n}}
            if index == 0 and histogram:
                terms["aggs"] = {"over_time": {"date_histogram": dict(histogram)}}
            aggs[f"g_{logical}"] = terms
            aggs[f"d_{logical}"] = {"cardinality": {"field": physical}}
        return {
            "size": 0,
            "track_total_hits": True,
            "query": {"bool": {"filter": filters}},
            "aggs": aggs,
        }

    @staticmethod
    def _bucket_time(key: Any) -> str:
        """A date_histogram key (epoch millis) as an ISO-8601 UTC string."""
        import datetime as _dt

        try:
            millis = int(float(key))
        except (TypeError, ValueError):
            return str(key)
        return _dt.datetime.fromtimestamp(millis / 1000, tz=_dt.timezone.utc).isoformat()

    async def aggregate(
        self,
        prefs: Preferences,
        query: StructuredQuery,
        group_by: list[str] | tuple[str, ...] = (),
        interval: str | None = None,
        top_n: int = 10,
        *,
        time_zone: str | None = None,
    ) -> AggregateResult | None:
        """Exact counts through ONE ``size: 0`` search on the read-only log key (#1).

        ``interval`` is a fixed width (``1m`` … ``1d``) or a calendar ``1w``/``1M``/
        ``1q``/``1y`` bucketed in ``time_zone`` (an IANA name; default UTC).

        Logical ``group_by`` names map through the source's effective field mapping
        (:func:`app.connectors.base.aggregate_field`). A ``terms`` aggregation on an
        analysed ``text`` field is a 400 on a real cluster ("fielddata is disabled"),
        so a 400 is retried ONCE with ``<field>.keyword`` (the default dynamic
        mapping's exact-value sub-field) on the fields the error names, or on every
        string group field when it names none of them. A field that was already
        ``keyword``/``ip`` typed has no ``.keyword`` sub-field and comes back as an
        EMPTY group, which would read as "exact, no values"; when a retried group is
        empty while events matched, the result is not trusted and ``None`` is
        returned. A search answered from part of its data (a failed shard, a timeout:
        :func:`response_is_complete`), any other failure, or an id lookup (not a
        population) returns ``None`` so the caller falls back to the newest-N sample
        path. Never raises."""
        if query.ids:
            return None
        try:
            prefs = self._effective_prefs(prefs)
            fields: dict[str, str] = {}
            for logical in dict.fromkeys(group_by or ()):
                physical = aggregate_field(prefs, str(logical))
                if physical:
                    fields[str(logical)] = physical
            iv = interval if interval in AGGREGATE_INTERVALS or interval in CALENDAR_INTERVALS else None
            zone = time_zone if isinstance(time_zone, str) and _TZ_NAME_RE.match(time_zone) else None
            top = max(1, min(int(top_n or 10), 50))
            filters, kql, time_from, time_to = self._aggregate_filters(prefs, query)
            body = self._aggregate_body(
                filters, fields, time_field=prefs.time_field, interval=iv, top_n=top, time_zone=zone,
            )
            retried: list[str] = []
            try:
                resp = await self._es.search_logs(prefs.data_view_pattern, body)
            except Exception as exc:  # noqa: BLE001 — classified below
                if _http_status(exc) != 400 or not fields:
                    raise
                candidates = {
                    logical: physical for logical, physical in fields.items()
                    if logical != "severity" and not physical.endswith(".keyword")
                }
                named = _fields_named_in(exc, candidates.values())
                retried = [logical for logical, physical in candidates.items()
                           if not named or physical in named]
                keyword_fields = {
                    logical: (f"{physical}.keyword" if logical in retried else physical)
                    for logical, physical in fields.items()
                }
                body = self._aggregate_body(
                    filters, keyword_fields, time_field=prefs.time_field, interval=iv, top_n=top,
                    time_zone=zone,
                )
                resp = await self._es.search_logs(prefs.data_view_pattern, body)
            if not response_is_complete(resp):
                # A failed shard or a timeout: every count and top list is missing that
                # shard's share, so nothing here is exact; the caller samples instead.
                logger.info("aggregate on %s: the search answered from part of its data; sampling instead",
                            self.connector_id)
                return None
            result = self._aggregate_result(
                resp, list(fields), interval=iv,
                rendering=QueryRendering(
                    # The same KQL rendering ``search`` reports (``_to_result``).
                    query=kql, language="kuery",
                    data_view=prefs.data_view_pattern,
                    time_from=time_from, time_to=time_to,
                ),
            )
            if result.total > 0 and any(not result.groups.get(logical) for logical in retried):
                # A ``.keyword`` guess hit a field with no such sub-field: an empty
                # group here is a mapping miss, not "no values" (G3).
                logger.info("aggregate on %s: a .keyword retry found no buckets; sampling instead",
                            self.connector_id)
                return None
            return result
        except Exception as exc:  # noqa: BLE001 — degrade to the sample path
            logger.warning("aggregate failed for %s: %s", self.connector_id, exc)
            return None

    async def aggregate_composite(
        self,
        prefs: Preferences,
        query: StructuredQuery,
        fields: list[str] | tuple[str, ...],
        *,
        interval: str | None = None,
        time_zone: str | None = None,
        page_size: int = COMPOSITE_PAGE_SIZE,
        max_buckets: int = COMPOSITE_MAX_BUCKETS,
    ) -> CompositeAggregate | None:
        """Exact counts per COMBINATION of ``fields`` (Round 14 SPEC §4.7.2: severity
        then rule, severity then time), through a paged ``composite`` aggregation on
        the read-only log key (#1).

        A two-level ``terms`` aggregation would keep only the top N children of each
        parent; a composite aggregation pages through every combination, so a level's
        rule count and its number of rules are exact. Every source carries
        ``missing_bucket`` so an event without the field is counted (a ``None`` key)
        rather than dropped. ``interval`` adds a leading ``date_histogram`` source
        (a shared ``AGGREGATE_INTERVALS`` or calendar width, or a whole number of
        minutes, hours or days such as ``12h``), bucketed in ``time_zone`` for a
        calendar width and in UTC otherwise.

        The filters are :meth:`_aggregate_filters`, the same clauses :meth:`search`
        builds, so the combinations describe the events a search returns. Paging stops
        at ``max_buckets`` combinations and reports ``complete=False``; a page answered
        from part of the data (a failed shard, a timeout: :func:`response_is_complete`)
        returns ``None``, never a partial count. A ``terms``
        source on an analysed ``text`` field is a 400 on a real cluster; it is retried
        ONCE on ``<field>.keyword`` as :meth:`aggregate` does, and a retried field
        whose every key comes back missing while events matched is a mapping miss:
        ``None`` is returned. An unknown field name, an id lookup or any failure
        returns ``None`` so the caller falls back to a stated sample. Never raises."""
        if query.ids:
            return None
        try:
            prefs = self._effective_prefs(prefs)
            physical: dict[str, str] = {}
            for logical in dict.fromkeys(str(f) for f in (fields or ())):
                path = aggregate_field(prefs, logical)
                if not path:
                    return None
                physical[logical] = path
            iv: str | None = None
            if interval:
                if not (interval in AGGREGATE_INTERVALS or interval in CALENDAR_INTERVALS
                        or _FIXED_INTERVAL_RE.match(str(interval))):
                    return None
                iv = str(interval)
            if not physical and iv is None:
                return None
            zone = time_zone if isinstance(time_zone, str) and _TZ_NAME_RE.match(time_zone) else None
            size = max(1, min(int(page_size or COMPOSITE_PAGE_SIZE), COMPOSITE_PAGE_SIZE))
            cap = max(1, int(max_buckets or COMPOSITE_MAX_BUCKETS))
            filters, kql, time_from, time_to = self._aggregate_filters(prefs, query)
            try:
                total, rows, complete = await self._composite_pages(
                    prefs, filters, physical, iv, zone, size, cap,
                )
                retried: list[str] = []
            except Exception as exc:  # noqa: BLE001 (classified below)
                if _http_status(exc) != 400 or not physical:
                    raise
                candidates = {
                    logical: path for logical, path in physical.items()
                    if logical != "severity" and not path.endswith(".keyword")
                }
                named = _fields_named_in(exc, candidates.values())
                retried = [logical for logical, path in candidates.items()
                           if not named or path in named]
                keyword_paths = {
                    logical: (f"{path}.keyword" if logical in retried else path)
                    for logical, path in physical.items()
                }
                total, rows, complete = await self._composite_pages(
                    prefs, filters, keyword_paths, iv, zone, size, cap,
                )
            offset = 1 if iv is not None else 0
            names = list(physical)
            for logical in retried:
                index = offset + names.index(logical)
                if total > 0 and all(keys[index] is None for keys, _count in rows):
                    # A ``.keyword`` guess hit a field with no such sub-field: every key
                    # missing is a mapping miss, not "no values" (the ``aggregate`` rule).
                    logger.info("composite on %s: a .keyword retry found no values; sampling instead",
                                self.connector_id)
                    return None
            return CompositeAggregate(
                total=total, fields=names, interval=iv, rows=rows, complete=complete,
                rendering=QueryRendering(
                    query=kql, language="kuery", data_view=prefs.data_view_pattern,
                    time_from=time_from, time_to=time_to,
                ),
            )
        except Exception as exc:  # noqa: BLE001 (degrade to the sample path)
            logger.warning("composite aggregate failed for %s: %s", self.connector_id, exc)
            return None

    async def aggregate_level_series(
        self,
        prefs: Preferences,
        query: StructuredQuery,
        ranges: dict[str, tuple[float | None, float | None]],
        *,
        interval: str,
        rest: str = "info",
        time_zone: str | None = None,
        page_size: int = COMPOSITE_PAGE_SIZE,
        max_buckets: int = COMPOSITE_MAX_BUCKETS,
    ) -> CompositeAggregate | None:
        """Exact event counts per (time bucket, named level) whatever the severity
        values are (Round 14 SPEC §4.6.2: the rule summary's series).

        :meth:`aggregate_composite` over ``(time, severity)`` pages one combination per
        distinct raw value, so a source whose severity is a continuous number can reach
        the bucket cap. This read pages the time buckets alone and counts each level
        inside them with one ``filters`` sub-aggregation of the levels' raw
        ``[gte, lt)`` ranges on the severity field (``ranges``, already projected
        through the source's own ceiling: :func:`app.engine.severity_levels.level_ranges`),
        so it costs one bucket per time bucket. An event in none of the ranges (a
        missing value, a value below the lowest bound) is counted under ``rest``. A
        ``range`` compares numbers, so a caller uses this only for a numeric severity
        field. ``rows`` are ``((bucket start, level), count)`` with zero counts left
        out; the filters are :meth:`_aggregate_filters` (the population a search
        returns). An id lookup, an unbounded or overlapping range (a bucket counted more
        than once), a page answered from part of the data or any failure returns
        ``None``. Never raises."""
        if query.ids:
            return None
        try:
            prefs = self._effective_prefs(prefs)
            if not (interval in AGGREGATE_INTERVALS or interval in CALENDAR_INTERVALS
                    or _FIXED_INTERVAL_RE.match(str(interval))):
                return None
            named: dict[str, dict[str, Any]] = {}
            for level, (gte, lt) in ranges.items():
                bound: dict[str, float] = {}
                if gte is not None:
                    bound["gte"] = float(gte)
                if lt is not None:
                    bound["lt"] = float(lt)
                if not bound or str(level) == rest:
                    return None
                named[str(level)] = {"range": {prefs.severity_field: bound}}
            if not named:
                return None
            zone = time_zone if isinstance(time_zone, str) and _TZ_NAME_RE.match(time_zone) else None
            size = max(1, min(int(page_size or COMPOSITE_PAGE_SIZE), COMPOSITE_PAGE_SIZE))
            cap = max(1, int(max_buckets or COMPOSITE_MAX_BUCKETS))
            filters, kql, time_from, time_to = self._aggregate_filters(prefs, query)
            rows: list[tuple[tuple[Any, ...], int]] = []
            overlapping = False

            def collect(keys: tuple[Any, ...], bucket: dict[str, Any]) -> None:
                nonlocal overlapping
                when = keys[0]
                counts = ((bucket.get("levels") or {}).get("buckets") or {})
                counted = 0
                for level in named:
                    n = int((counts.get(level) or {}).get("doc_count") or 0)
                    counted += n
                    if n:
                        rows.append(((when, level), n))
                remainder = int(bucket.get("doc_count") or 0) - counted
                if remainder < 0:
                    overlapping = True
                elif remainder:
                    rows.append(((when, rest), remainder))

            total, _times, complete = await self._composite_pages(
                prefs, filters, {}, str(interval), zone, size, cap,
                sub_aggs={"levels": {"filters": {"filters": named}}}, visit=collect,
            )
            if overlapping:
                logger.info("level series on %s: an event fell in two level ranges; not exact",
                            self.connector_id)
                return None
            return CompositeAggregate(
                total=total, fields=["level"], interval=str(interval), rows=rows, complete=complete,
                rendering=QueryRendering(
                    query=kql, language="kuery", data_view=prefs.data_view_pattern,
                    time_from=time_from, time_to=time_to,
                ),
            )
        except Exception as exc:  # noqa: BLE001 (the caller keeps what it has)
            logger.warning("level series failed for %s: %s", self.connector_id, exc)
            return None

    async def _composite_pages(
        self,
        prefs: Preferences,
        filters: list[dict[str, Any]],
        paths: dict[str, str],
        interval: str | None,
        time_zone: str | None,
        size: int,
        cap: int,
        *,
        sub_aggs: dict[str, Any] | None = None,
        visit: Callable[[tuple[Any, ...], dict[str, Any]], None] | None = None,
    ) -> tuple[int, list[tuple[tuple[Any, ...], int]], bool]:
        """Page one composite aggregation to its end or to ``cap`` combinations:
        ``(exact total, rows, complete)``. ``sub_aggs`` run inside every bucket and
        ``visit(keys, bucket)`` sees each raw bucket (its sub-aggregation results).
        Raises what the search raises, and :class:`IncompleteSearchError` for a page
        answered from part of the data."""
        sources: list[dict[str, Any]] = []
        if interval is not None:
            sources.append({"t": {"date_histogram": self._histogram(prefs.time_field, interval, time_zone)}})
        for logical, path in paths.items():
            sources.append({f"f_{logical}": {"terms": {"field": path, "missing_bucket": True}}})
        rows: list[tuple[tuple[Any, ...], int]] = []
        total: int | None = None
        after: dict[str, Any] | None = None
        complete = True
        while True:
            composite: dict[str, Any] = {"size": size, "sources": copy.deepcopy(sources)}
            if after is not None:
                composite["after"] = after
            pairs_agg: dict[str, Any] = {"composite": composite}
            if sub_aggs:
                pairs_agg["aggs"] = copy.deepcopy(sub_aggs)
            body = {
                "size": 0,
                "track_total_hits": True,
                "query": {"bool": {"filter": copy.deepcopy(filters)}},
                "aggs": {"pairs": pairs_agg},
            }
            resp = await self._es.search_logs(prefs.data_view_pattern, body)
            if not response_is_complete(resp):
                # One partial page (a failed shard, a timeout) makes the whole set a
                # lower bound: the caller's ``None`` path states a sample instead.
                raise IncompleteSearchError("a composite page answered from part of its data")
            if total is None:
                hits_total = (resp.get("hits") or {}).get("total")
                if isinstance(hits_total, dict):
                    total = int(hits_total.get("value") or 0)
                else:
                    total = int(hits_total or 0)
            pairs = (resp.get("aggregations") or {}).get("pairs") or {}
            buckets = [b for b in pairs.get("buckets") or [] if isinstance(b, dict)]
            for bucket in buckets:
                key = bucket.get("key") or {}
                keys: list[Any] = []
                if interval is not None:
                    t = key.get("t")
                    keys.append(None if t is None else self._bucket_time(t))
                for logical in paths:
                    keys.append(key.get(f"f_{logical}"))
                rows.append((tuple(keys), int(bucket.get("doc_count") or 0)))
                if visit is not None:
                    visit(tuple(keys), bucket)
            after_key = pairs.get("after_key")
            if not buckets or len(buckets) < size or not isinstance(after_key, dict):
                break
            if len(rows) >= cap:
                complete = False
                break
            after = after_key
        return int(total or 0), rows, complete

    def _aggregate_result(
        self,
        resp: dict[str, Any],
        logical_fields: list[str],
        *,
        interval: str | None,
        rendering: QueryRendering,
    ) -> RankedAggregateResult:
        """Parse the aggregation response. A missing aggregation degrades to an empty
        group rather than failing the whole result. Each group's count error bound is
        kept (:class:`RankedAggregateResult`), so a caller can tell an exact top list
        from one a multi-shard read only approximated."""
        hits_total = (resp.get("hits") or {}).get("total")
        if isinstance(hits_total, dict):
            total = int(hits_total.get("value") or 0)
        else:
            total = int(hits_total or 0)
        aggs = resp.get("aggregations") or {}
        groups: dict[str, list[AggregateBucket]] = {}
        other: dict[str, int] = {}
        error_bound: dict[str, int] = {}
        distinct: dict[str, int] = {}
        matrix: dict[str, list[AggregateBucket]] | None = None
        for index, logical in enumerate(logical_fields):
            terms = aggs.get(f"g_{logical}") or {}
            buckets = [b for b in terms.get("buckets") or [] if isinstance(b, dict)]
            groups[logical] = [
                AggregateBucket(key=str(b.get("key")), count=int(b.get("doc_count") or 0))
                for b in buckets
            ]
            if "sum_other_doc_count" in terms:
                other[logical] = int(terms.get("sum_other_doc_count") or 0)
            else:
                # Backends (and the offline fake) that omit it: the remainder of the
                # exact total. A multi-valued field can make this a lower bound only.
                other[logical] = max(0, total - sum(g.count for g in groups[logical]))
            bound = terms.get("doc_count_error_upper_bound")
            if isinstance(bound, (int, float)) and not isinstance(bound, bool):
                error_bound[logical] = int(bound)
            elif "buckets" in terms and "sum_other_doc_count" not in terms and bound is None:
                # A backend that reports neither figure (the offline fake) answers from
                # one shard with exact counts: the assumption the remainder above makes.
                error_bound[logical] = 0
            card = (aggs.get(f"d_{logical}") or {}).get("value")
            if isinstance(card, (int, float)):
                distinct[logical] = int(card)
            if index == 0:
                sub = {
                    str(b.get("key")): [
                        AggregateBucket(key=self._bucket_time(t.get("key")), count=int(t.get("doc_count") or 0))
                        for t in ((b.get("over_time") or {}).get("buckets") or [])
                        if isinstance(t, dict)
                    ]
                    for b in buckets
                    if isinstance(b.get("over_time"), dict)
                }
                matrix = sub or None
        over_time = [
            AggregateBucket(key=self._bucket_time(b.get("key")), count=int(b.get("doc_count") or 0))
            for b in ((aggs.get("over_time") or {}).get("buckets") or [])
            if isinstance(b, dict)
        ]
        return RankedAggregateResult(
            total=total, groups=groups, other=other, distinct=distinct,
            over_time=over_time, interval=interval, matrix=matrix, rendering=rendering,
            error_bound=error_bound,
        )

    # --------------------------------------------------------------------- #
    # Normalisation + helpers
    # --------------------------------------------------------------------- #
    def to_ocsf(self, raw: dict[str, Any], prefs: Preferences) -> OCSFEvent:
        """Map one ES hit (``{_id,_index,_source}``) to a canonical OCSFEvent.

        Delegates to the existing ECS→OCSF mapper, stamping this connector's
        ``source_type`` and ``connector_id`` for provenance.
        """
        prefs = self._effective_prefs(prefs)
        return ecs_to_ocsf(
            raw, prefs, source_type=self.source_type, connector_id=self.connector_id
        )

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        """Validate a READ-ONLY, log-scoped key the right way.

        A correctly-scoped read-only key (read on the index pattern, no cluster
        monitor) CANNOT do HEAD / (ping). So we do NOT gate on ping(): we run the
        cheap scoped sample read FIRST and treat HTTP 200 (any/zero hits) as success,
        reporting mode="read_only". ping() is only an EXTRA signal (cluster_monitor
        true/false), never the pass/fail gate. We return ok=False only when the scoped
        read itself fails — auth (401/403 on the index) or network/TLS."""
        prefs = self._effective_prefs(prefs)
        pattern = prefs.data_view_pattern
        # 1) Authoritative: a cheap, scoped, read-only sample read.
        try:
            body = poll_query(prefs, Cursor(), 0, batch_size=1)
            resp = await self._es.search_logs(pattern, body)
        except Exception as exc:  # noqa: BLE001
            status = _http_status(exc)
            if status in (401, 403):
                msg = (f"Read access denied on '{pattern}' (HTTP {status}). The API key "
                       f"needs the 'read' privilege on that index pattern.")
            else:
                msg = (f"Could not reach Elasticsearch (network/TLS) while reading "
                       f"'{pattern}': {exc}")
            return ConnectionTest(ok=False, message=msg,
                                  detail={"data_view": pattern, "error": str(exc)})
        total = resp.get("hits", {}).get("total", {})
        count = total.get("value") if isinstance(total, dict) else (
            total if isinstance(total, int) else None)
        n = count if count is not None else 0
        # 2) OPTIONAL extra signal: can this key also reach the cluster root (HEAD /)?
        #    A scoped read-only key cannot — that's expected, NOT a failure.
        try:
            cluster_monitor = bool(await self._es.ping())
        except Exception:  # noqa: BLE001
            cluster_monitor = False
        if cluster_monitor:
            mode = "full"
            message = (f"Connection verified — {n} event(s) readable in '{pattern}'; "
                       f"cluster-monitor privilege present.")
        else:
            mode = "read_only"
            message = (f"Read-only access verified — logs are ingesting successfully "
                       f"({n} events readable in '{pattern}'). Cluster-monitor privilege "
                       f"not granted (expected for a read-only key).")
        return ConnectionTest(ok=True, message=message, mode=mode, sample_count=count,
                              cluster_monitor=cluster_monitor, detail={"data_view": pattern})

    def _to_result(
        self,
        resp: dict[str, Any],
        prefs: Preferences,
        kql: str,
        time_from: str | None,
        time_to: str | None,
        *,
        fields_searched: list[str] | None = None,
    ) -> SearchResult:
        """Wrap a native ES response in a :class:`SearchResult` with provenance.

        ``fields_searched`` records which fields a free-text ``contains`` was matched
        against, so a zero-hit result can be reported as "no match in THESE fields"
        rather than as proof the data is absent. It defaults to empty for every
        caller that ran no free-text filter.
        """
        hits = resp.get("hits", {}).get("hits", [])
        total = resp.get("hits", {}).get("total", {})
        total_val = total.get("value", len(hits)) if isinstance(total, dict) else len(hits)
        events = self._tag_events([RawEvent.from_hit(h, prefs) for h in hits], prefs=prefs)
        rendering = QueryRendering(
            query=kql,
            language="kuery",
            data_view=prefs.data_view_pattern,
            time_from=time_from,
            time_to=time_to,
            fields_searched=list(fields_searched or []),
        )
        return SearchResult(events=events, total=total_val, rendering=rendering, raw=resp)
