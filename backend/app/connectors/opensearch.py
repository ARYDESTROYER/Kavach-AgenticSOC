"""OpenSearch pull connector — intentional reuse of :class:`ElasticConnector`.

OpenSearch's _search API is forked from (and remains compatible with) the
Elasticsearch 7.10 query DSL the suite emits, so polling, structured search and
``fetch_by_ids`` all work unchanged through ``BaseESClient.search_logs``. This
connector therefore subclasses :class:`ElasticConnector` verbatim and overrides
only its identity (``source_type``), its native query language (``lucene``) and
its wizard manifest. Keeping a distinct class preserves correct provenance on
every OCSF event (``metadata.source_type == "opensearch"``) and lets the wizard
present OpenSearch-specific auth guidance.
"""

from __future__ import annotations

from ..constants import IngestMode, SourceType
from .base import AuthField, ConnectorManifest
from .elastic import ElasticConnector


class OpenSearchConnector(ElasticConnector):
    """Pull connector for OpenSearch (and the OpenSearch Dashboards stack).

    Inherits ALL behaviour from :class:`ElasticConnector` (ping/poll/search/
    fetch_by_ids/to_ocsf/aggregate) because the OpenSearch search API is ES-compatible
    through :meth:`BaseESClient.search_logs`. That includes the calendar buckets of
    ``aggregate`` (``1w``/``1M``/``1q``/``1y`` → ``date_histogram.calendar_interval``
    with the operator ``time_zone``, Round 12 SPEC P0-5): OpenSearch supports
    ``calendar_interval`` with the same unit names, and Wazuh's indexer is OpenSearch.
    Only identity + wizard metadata differ.
    """

    source_type = SourceType.OPENSEARCH

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        """OpenSearch self-description (API ≈ ES 7.10; Lucene query language).

        Mirrors the Elastic manifest's connection + field-mapping fields, but
        notes the ES-7.10 compatibility caveat and surfaces OpenSearch-specific
        auth guidance (basic auth or AWS SigV4 for Amazon OpenSearch Service).
        """
        return ConnectorManifest(
            source_type=cls.source_type,
            display_name="OpenSearch",
            category="siem",
            description=(
                "Poll a read-only OpenSearch index pattern on a durable cursor "
                "and run ad-hoc structured searches. The OpenSearch search API is "
                "compatible with the Elasticsearch 7.10 query DSL this suite emits."
            ),
            ingest_modes=[IngestMode.PULL],
            query_language="lucene",
            capabilities=["poll", "search", "fetch_by_ids", "test", "browse"],
            docs_url="https://opensearch.org/docs/latest/security/access-control/api/",
            setup_help=(
                "## Connect OpenSearch\n"
                "1. **URL** — the OpenSearch HTTP API base URL (for Amazon OpenSearch "
                "Service use the domain endpoint).\n"
                "2. **Read-only credential** — create a role/user scoped to READ on your "
                "log index pattern (never an admin). OpenSearch supports HTTP basic auth "
                "(`user:password`); on AWS, SigV4 request signing.\n"
                "3. **Index pattern** — set the data view the agent reads (read-only).\n"
                "4. **CA cert** — paste the PEM (or a mounted path) for a private CA.\n"
                "_The search API is ES-7.10 compatible with the DSL this suite emits._"
            ),
            auth_fields=[
                AuthField(
                    key="es_url",
                    label="OpenSearch URL",
                    type="string",
                    required=True,
                    placeholder="https://opensearch:9200",
                    help=(
                        "Base URL of the OpenSearch HTTP API. For Amazon OpenSearch "
                        "Service use the domain endpoint."
                    ),
                    help_link="https://opensearch.org/docs/latest/api-reference/index/",
                    group="Connection",
                ),
                AuthField(
                    key="es_api_key",
                    label="Credential (read-only)",
                    type="password",
                    secret=True,
                    help=(
                        "Read-only credential scoped to the log index pattern. "
                        "OpenSearch supports HTTP basic auth (user:password) and, on "
                        "Amazon OpenSearch Service, AWS SigV4 request signing. Stored "
                        "in the secret store; shown only as configured."
                    ),
                    group="Connection",
                ),
                AuthField(
                    key="es_ca_cert",
                    label="CA certificate (PEM)",
                    type="textarea",
                    help=(
                        "PEM-encoded CA certificate (or a mounted path) used to "
                        "verify the TLS connection to OpenSearch."
                    ),
                    group="Connection",
                ),
                AuthField(
                    key="es_verify_certs",
                    label="Verify TLS certificates",
                    type="bool",
                    default=True,
                    help=(
                        "Verify the OpenSearch server certificate against the CA. "
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
                    help="The OpenSearch index pattern the agent reads (read-only).",
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
                    help="Per-event rule identity used for scope and correlation.",
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
                    help="Numeric severity field (layer-1 cost-gate filter).",
                    group="Field mapping",
                ),
            ],
        )
