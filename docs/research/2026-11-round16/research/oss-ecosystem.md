# Round 16 research: the free and open-source SOC ecosystem (key `oss-ecosystem`)

Scope: what would make Agentic SOC the ideal free, self-hosted agentic SOC, measured against the
free and open-source tools people already run (Wazuh, Security Onion, TheHive and Cortex,
DFIR-IRIS, Shuffle, OpenCTI, MISP, Velociraptor, Sigma, YARA, Zeek, Suricata, osquery, Graylog,
OpenSearch Security Analytics, the Elastic free tier, and local models through Ollama, vLLM and
LiteLLM). Repository state read at `claude/round16`, commit `3cfd5c0`. Work was read-only: no
repository file was edited. Two scratch probes ran from the scratchpad (a URL-path probe of the
OpenAI-compatible client and a memory reading of an idle backend on SQLite).

Every external claim carries its source URL. Claims marked **(unverified)** could not be confirmed
from a primary source during this research.

---

## 1. Ranked gaps for a free, self-hosted user

| Rank | Gap | Value | Effort | Fits Round 16 |
|---|---|---|---|---|
| 1 | No project license: the code cannot legally be used, changed or shared | high | S (owner decision) | yes, as a decision |
| 2 | **Bug:** a local model base URL ending in `/v1` (what the dialog tells people to type) calls `/v1/v1/chat/completions` and fails | high | S | yes |
| 3 | No free local-model path from install to first verdict (no Ollama overlay, wizard needs a paid key, no context or JSON-mode safeguards) | high | M | partly |
| 4 | Per-source secrets (webhook bearer tokens, second-source API keys) are lost on every restart, and the Compose stack has no restart-safe path for them | high | M | partly |
| 5 | No one-command install, no doctor, no published resource figures, no lite profile | high | M | partly |
| 6 | No source presets for the free tools people actually run (Wazuh push, Suricata EVE, Zeek, osquery, Security Onion, Graylog, Elastic Security alerts, OpenSearch findings); no inverted severity ladder | high | M | yes |
| 7 | No offline threat intel: no MISP warninglists, no public MISP feeds, no TAXII 2.1, no MISP or OpenCTI | high | M to L | warninglists only |
| 8 | No hand-off to a free case tool (DFIR-IRIS, TheHive) and no STIX 2.1 export | high (IRIS) | M | maybe |
| 9 | No Sigma import (metadata first, matcher later) | medium | M (metadata), L (matcher) | no |
| 10 | Integration recipes and a "free stack" guide are missing from the docs | high | S to M | yes |
| 11 | No CVE context (CISA KEV, EPSS) and no CVE indicator kind | medium | M | no |
| 12 | Runbooks import one Markdown file at a time; no community pack | medium | M | no |
| 13 | No Cortex bridge (140+ analyzers for people who already run Cortex) | medium | M | no |
| 14 | No MCP server for the Open WebUI and Ollama crowd | medium | L | no |
| 15 | Trying it needs Python 3.11 and Node 22 on the host; no container demo or devcontainer | medium | S to M | maybe |

---

## 2. What already exists (inventory)

| Area | What is there | Where |
|---|---|---|
| Pull connectors | Elasticsearch, OpenSearch, Wazuh indexer (`wazuh-alerts-*`, Wazuh field defaults). Splunk, Sentinel, QRadar, Chronicle, CrowdStrike, SentinelOne, Defender are enum slots only | `backend/app/connectors/{elastic,opensearch,wazuh}.py`, `backend/app/constants.py` `SourceType` |
| Push receivers | 16: webhook, HEC, syslog (UDP/TCP/TLS), file, Redis Streams, Kafka, SQS, Kinesis, Event Hub, Pub/Sub, RabbitMQ, NATS, MQTT, S3, GCS, Azure Blob. `BEATS`, `FLUENTD`, `OTLP`, `PULSAR` are enum slots without a receiver | `backend/app/connectors/receivers/` |
| Formats | JSON, NDJSON, CEF, LEEF, GELF, RFC 3164, RFC 5424, key/value, raw | `backend/app/connectors/receivers/formats.py` |
| Push endpoint | `POST /api/ingest/{source_id}`, auth `none`, `bearer` or `hmac`; per-source secrets read from the in-memory secret tier | `backend/app/api/routes.py` `ingest_push`, `receivers/webhook.py` `verify_auth` |
| Field mapping | Per-source and per-feed mapping, deterministic mapping suggestion from a pasted sample, `severity_scale_max` (a linear ceiling only) | `backend/app/config.py` `SourceInstance`, `backend/app/engine/sample_analysis.py`, `backend/app/ocsf/model.py` |
| Enrichment | 38 provider classes; keyless defaults on (Shodan InternetDB, ipinfo lite, URLhaus, ThreatFox, MalwareBazaar, RDAP, CIRCL hashlookup, DShield, Onionoo). No MISP, OpenCTI, TAXII, warninglist, KEV or EPSS. Providers have no per-provider base URL, so a self-hosted intel server has no place to be configured | `backend/app/enrichment/providers/`, `backend/app/config.py` `EnrichmentConfig` |
| Local models | "Add a local model" (`POST /api/llm/models/custom`), $0 metering, a non-metered "Fetch models" probe, `litellm_api_key` secret slot | `backend/app/api/routes_models.py`, `backend/app/stores/custom_models.py`, `webui/src/soc/pages/Models.tsx` |
| Default models | Every completion role defaults to `gpt-5.6-luna` (OpenAI, paid); embeddings default to `text-embedding-3-small`, with a 256-dimension hashing fallback | `backend/app/config.py` `DEFAULT_COMPLETION_MODEL`, `llm/providers.py` `_hash_embed` |
| Setup wizard | The models step asks for provider keys; `openai_compatible` is listed only as a key slot, with no way to register an endpoint or assign roles to it | `webui/src/soc/pages/wizard/RuntimeReviewSteps.tsx` `PROVIDERS` |
| Investigator output | JSON in free text, parsed with `extract_json`, one "Respond with ONLY a valid JSON action object" retry; no `response_format` is sent to any provider | `backend/app/agents/investigator.py`, `backend/app/llm/providers.py` |
| Rules | `RuleMatch` is one predicate (`equals`, `prefix`, `tag`, `exists`); no Sigma import or export | `backend/app/config.py` `RuleMatch`, `RuleDefinition`; `backend/app/api/routes_rules.py` |
| Case output | JSON or Markdown export only. Notification channels: email, Resend, generic webhook, Slack, Teams, PagerDuty, Telegram, in-app | `backend/app/api/routes.py` `case_export`, `backend/app/notifications/` |
| Runbooks | 12 built-ins (native Markdown with front matter, ATT&CK ids, `applies_when`); import is one Markdown source at a time, always as a Draft | `backend/app/runbooks/library/`, `backend/app/api/routes_runbooks.py` `import_runbook` |
| Deploy | `docker-compose.agnostic.yml` (PostgreSQL with pgvector, Redis, backend, Console, updater), `docker-compose.tlsoc.yml`, `docker-compose.enrichment-keys.yml`. The base file's bytes are frozen for the 0.1.x update protocol (`deploy/update-base-v1.sha256`), so every new profile must be a separate file. No install script, no local-model overlay, no lite profile | `deploy/`, `INSTALL.md` section 5 |
| Resource figures | `INSTALL.md` section 3 says the repository does not publish CPU, memory or disk figures | `INSTALL.md` |
| License | No `LICENSE` file; `README.md` and `docs/releases/known-limitations.md` say a license decision is required | `README.md` "License", `docs/releases/known-limitations.md` |

Measured in this sandbox: the backend (`uvicorn app.main:app`, `STATE_BACKEND=sqlite`, Redis
unreachable, no sources, no Demo Mode) reached `/api/health/ready` and held **about 262 MiB
resident** (VmRSS 268,096 kB after a few API calls). This is a floor for an idle install, not a
sizing figure under load.

---

## 3. The ecosystem at a glance

| Tool | What matters for us | How a user connects it today | Opportunity |
|---|---|---|---|
| Wazuh | One-command installer, `curl -sO https://packages.wazuh.com/4.14/wazuh-install.sh && sudo bash ./wazuh-install.sh -a`; 4 vCPU and 8 GiB for up to 25 agents ([Wazuh quickstart](https://documentation.wazuh.com/current/quickstart.html)). The Integrator runs `custom-*` scripts from `/var/ossec/integrations/` with three arguments: alert file, `api_key`, `hook_url` ([Wazuh external API integration](https://documentation.wazuh.com/current/user-manual/manager/integration-with-external-apis.html)). The built-in `shuffle` integration posts `{severity, pretext, title, text, rule_id, timestamp, id, all_fields}` with no auth header ([wazuh/wazuh shuffle.py v4.14.1](https://raw.githubusercontent.com/wazuh/wazuh/v4.14.1/integrations/shuffle.py)) | Pull from the indexer with a read-only role | Ship a `custom-agentic-soc` Integrator script for real-time bearer-authenticated push (recommendation R6) |
| Security Onion | 2.4 standalone minimum 24 GB RAM; Eval mode 8 GB ([Security Onion hardware](https://docs.securityonion.net/en/2.4/_sources/hardware.rst.txt)). Elasticsearch data streams such as `.ds-logs-zeek-so-*` ([SO Elasticsearch](https://docs.securityonion.net/en/2.4/elasticsearch.html)); NIDS alerts found with `event.module:"suricata"` and `event.dataset:"alert"` ([SO alert data fields](https://securityonion.readthedocs.io/en/2.4/alert-data-fields.html)). Version 3 docs now exist ([SO 3 Elasticsearch](https://docs.securityonion.net/en/3/main/elasticsearch/)) | Elastic connector, hand-configured | A preset (R6). Note `soc-ai`, an Apache-2.0 LLM triage tool for Security Onion 3, already exists ([soc-ai README](https://raw.githubusercontent.com/nuk3s/soc-ai/main/README.md)) |
| TheHive 5 | Community edition is "for non-commercial use", needs a license from the StrangeBee portal, and becomes read-only after the 14-day trial without one ([StrangeBee licenses](https://docs.strangebee.com/thehive/installation/licenses/about-licenses/)). Alerts need `type`, `source`, `sourceRef`, unique as a tuple ([TheHive4py alert](https://thehive-project.github.io/TheHive4py/latest/examples/alert)). The v5 create path is likely `POST /api/v1/alert` **(unverified)** | Not connected | Secondary hand-off target (R8); not a "free for everyone" default |
| Cortex | AGPL, free; some analyzers need third-party subscriptions ([TheHive-Project Cortex README](https://raw.githubusercontent.com/TheHive-Project/Cortex/master/README.md), [analyzer requirements](https://github.com/TheHive-Project/CortexDocs/blob/2.1/analyzer_requirements.md)); API keys as bearer ([Cortex API guide](https://docs.strangebee.com/cortex/api/api-guide)). Exact run path **(unverified)** | Not connected | Bridge provider (R13) |
| DFIR-IRIS | LGPL-3.0, Docker deploy ([LinuxLinks](https://www.linuxlinks.com/dfir-iris-collaborative-incident-response-platform/)); latest stable v2.4.29, v3.0.0-beta not for production ([iris-web releases](https://github.com/dfir-iris/iris-web/releases)). Alerts via `POST /alerts/add` with a Bearer key; fields `alert_title`, `alert_description`, `alert_source`, `alert_source_ref`, `alert_source_link`, `alert_severity_id` (1 to 6), `alert_status_id`, `alert_source_event_time`, `alert_tags`, `alert_customer_id`, `alert_source_content` ([Wazuh and DFIR-IRIS blog](https://wazuh.com/blog/enhancing-incident-response-with-wazuh-and-dfir-iris-integration/)) | Not connected | Primary free hand-off target (R8) |
| Shuffle | Open-source SOAR, Docker Compose install, built-in Wazuh integration ([Wazuh and Shuffle](https://wazuh.com/blog/wazuh-integration-with-shuffle/)). License **(unverified)** | Generic webhook in either direction | Document a recipe (R10); no code |
| OpenCTI | TAXII 2.1 server with filter-based collections; `Authorization: Bearer <API key>`; live streams over SSE carrying STIX 2.1; CSV feeds ([OpenCTI integrations](https://docs.opencti.io/latest/deployment/integrations/)) | Not connected | TAXII 2.1 pull into a local IOC store (R7) |
| MISP | `POST /attributes/restSearch` with the raw key in `Authorization` (no `Bearer`), `returnFormat: json`, `to_ids`, `timestamp`, `publish_timestamp` (preferred over legacy `last`), `enforceWarninglist`, `page`/`limit` ([CIRCL MISP automation](https://www.circl.lu/doc/misp/automation/)). Warninglists are CC0, about 160 lists, types `string`, `substring`, `hostname`, `cidr`, `regex`, covering public DNS resolvers, CDNs, cloud ranges, Tranco and Majestic ([MISP/misp-warninglists](https://github.com/MISP/misp-warninglists)). 18 public feeds in MISP format, among them CIRCL OSINT, Botvrij, DigitalSide, URLhaus, ThreatFox, MalwareBazaar ([MISP default feeds](https://www.misp-project.org/feeds/)); a feed is a `manifest.json` plus one JSON file per event ([MISP feed training](https://www.misp-project.org/misp-training/a.3-misp-feed.pdf)) | Not connected | Warninglists and public feeds need no MISP server and no key (R7) |
| Velociraptor | Server event artifacts post to other tools, for example `Server.Alerts.Monitor.IRIS`, a `SERVER_EVENT` that watches `System.Flow.Completion` and posts with `http_client` and a Bearer key ([Velociraptor exchange: IRIS](https://docs.velociraptor.app/exchange/artifacts/pages/server.alerts.monitor.iris)) | Generic webhook | A copy of that artifact aimed at `/api/ingest/{id}` (R10) |
| Sigma | Rules under the Detection Rule License 1.1: commercial use allowed, but the author must be credited, including in views that show matches ([Detection Rule License](https://github.com/SigmaHQ/Detection-Rule-License), [SigmaHQ](https://github.com/sigmahq/sigma)). `pySigma-pipeline-ocsf` provides `ocsf_pipeline()` ([PyPI](https://pypi.org/project/pySigma-pipeline-ocsf/)). pySigma license **(unverified)** | Not supported | Metadata import first (R9) |
| OpenSearch Security Analytics | Ships 2,200+ Sigma rules ([AWS docs](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/security-analytics.html)); findings indices `.opensearch-sap-<detector_type>-findings-<date>` ([OpenSearch 2.15 settings](https://opensearch.org/docs/2.15/security-analytics/settings)); findings API `GET /_plugins/_security_analytics/findings/_search` ([OpenSearch 3.5 API](https://docs.opensearch.org/3.5/security-analytics/api-tools/alert-finding-api/)) | OpenSearch connector, hand-configured | Preset (R6) |
| Elastic free tier | Prebuilt detection rules are a Basic-level integration ([Elastic prebuilt rules](https://www.elastic.co/docs/reference/integrations/security_detection_engine)); alerts live in `.alerts-security.alerts-<space-id>` ([Elastic detections privileges](https://www.elastic.co/docs/solutions/security/detect-and-alert/detections-privileges)) | Elastic connector; the default index is the legacy `all-logs-*` | Preset (R6) |
| Graylog | GELF already parsed; event-definition alerts are searchable at `POST /api/events/search` and stored in a Graylog events index ([Graylog community](https://community.graylog.org/t/how-can-i-get-triggered-alerts-via-api/21384)) **(index name unverified)**; Custom HTTP notifications arrived in 6.0 ([Graylog community](https://community.graylog.org/t/custom-http-notification/31118)) | Webhook or syslog | Recipe plus preset (R6, R10) |
| Zeek, Suricata, osquery | Zeek JSON via `LogAscii::use_json` with `uid` joining logs, `notice.log` keys `note`, `msg`, `src`, `dst` ([Zeek json-logs](https://docs.zeek.org/en/master/scripts/policy/tuning/json-logs.zeek.html), [Zeek MUC 2025 deck](https://zeek.org/wp-content/uploads/2025/03/MUC-2025-Meet-Spicy.pdf)). Suricata EVE `alert.severity` where lower is more severe (Chronicle maps 0 to 2 to CRITICAL) ([Suricata EVE format](https://docs.suricata.io/en/suricata-7.0.12/output/eve/eve-json-format.html), [Chronicle SURICATA_EVE](https://docs.cloud.google.com/chronicle/docs/ingestion/parser-list/suricata-eve-changelog?authuser=8)). osquery differential results in `/var/log/osquery/osqueryd.results.log` with `name`, `hostIdentifier`, `columns`, `action` ([osquery logging](https://osquery.readthedocs.io/en/4.5.1/deployment/logging/)) | File receiver or syslog, hand-mapped | Presets (R6) |
| YARA | Matches reach us through Wazuh, Velociraptor and MalwareBazaar signature names (our assessment) | Indirect | No dedicated work recommended |
| Ollama | `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`; JSON mode and tools supported, `tool_choice` not ([Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)); `json_schema` structured outputs work locally, not on Ollama Cloud ([Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)). Default context 4096 in the FAQ, overridable with `OLLAMA_CONTEXT_LENGTH`; the OpenAI API cannot set context size per request, so long prompts can be cut silently ([Ollama context length](https://docs.ollama.com/context-length), [Ollama FAQ](https://docs.ollama.com/faq)) | "Add a local model", but see the `/v1` bug | Local-first path (R2, R3) |
| vLLM | Structured outputs on by default; `response_format` with `json_schema` on the OpenAI-compatible server ([vLLM structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/)) | "Add a local model" | JSON mode flag (R3) |
| Open-weight models | `gpt-oss-20b`: Apache-2.0, runs within 16 GB, tools ([model card](https://huggingface.co/openai/gpt-oss-20b), [Ollama](https://ollama.com/library/gpt-oss:20b)). Qwen3: Apache-2.0, 0.6B to 32B dense plus MoE ([Qwen3 blog](https://qwenlm.github.io/blog/qwen3/)) | n/a | Tested presets, not hard-coded defaults (R3) |
| Competitor: AiSOC | MIT; `install.sh` and `install.ps1`, `make doctor`, a pip sandbox demo; Ollama bundled with `llama3.2:3b-instruct-q4_K_M` (about 2 GB) for CPU; about 8 GB RAM core profile; keyless CISA KEV ([AiSOC README](https://raw.githubusercontent.com/beenuar/AiSOC/main/README.md)). The project's own claims are self-reported | n/a | Benchmark for install and local-model experience |
| Competitor: Wazuh MCP servers | `gensecaihq/wazuh-mcp-server` (Open WebUI with Ollama, air-gappable) and `gbrigandi/mcp-server-wazuh` ([mcpservers.org](https://mcpservers.org/servers/gensecaihq/wazuh-mcp-server)) | n/a | Context for R14 |

---

## 4. Bugs and defects found during this research

### B1 (high): a `/v1` base URL doubles the path for every local model

- **Evidence.** `OpenAIProvider.__init__` builds `httpx.AsyncClient(base_url=base_url)` and then
  posts to `"/v1/chat/completions"` and `"/v1/embeddings"` (`backend/app/llm/providers.py`, the
  `OpenAIProvider` class and its `embed`). httpx joins the two paths. A scratch probe against a
  local stub server printed:

  ```
  http://127.0.0.1:<port>/v1 -> /v1/v1/chat/completions ERR ProviderError HTTP 404
  http://127.0.0.1:<port>    -> /v1/chat/completions ok
  ```

- **Why it bites.** The dialog says the URL "Usually ends in `/v1`, for example
  `http://localhost:4000/v1` (LiteLLM) or `http://localhost:11434/v1` (Ollama)"
  (`webui/src/soc/pages/Models.tsx`), and the "Fetch models" probe handles `/v1` correctly
  (`routes_models.py`, `{root}/models`), so the user sees success and then every investigation
  and embedding call fails. `backend/tests/test_custom_models.py` asserts the factory receives
  `http://litellm:4000/v1` but never checks the request path.
- **Fix.** Normalise once in `_make_openai_compatible` (and in the `openai` factory when a custom
  `base_url` is set): strip one trailing `/v1` (and a trailing slash) before building the client.
  Keep the stored `base_url` as the operator typed it.
- **Test.** An httpx `MockTransport` test that records `request.url.path` for base URLs
  `http://h/v1`, `http://h/v1/`, `http://h` and `http://h/openai/v1`, for both `complete` and
  `embed`, expecting `/v1/chat/completions` (and `/openai/v1/chat/completions` for the prefixed
  proxy).

### B2 (high): per-source secrets do not survive a restart in the Compose stack

- `Secrets.connector_secrets` is the only home of a webhook bearer token or a second source's API
  key (`backend/app/config.py`). `verify_auth` fails closed when the token is empty
  (`receivers/webhook.py`), so after any backend restart every bearer or HMAC push source answers
  `401` until someone re-enters the secret. The base Compose file forwards `SSO_CLIENT_SECRETS`
  and `NOTIFICATION_SECRETS` but not `CONNECTOR_SECRETS`, and `.env.example` does not mention it.
  Senders that do not retry lose alerts. Recommendation R4 covers the fix.

### B3 (medium): the local-model example URL is wrong inside Compose

- `http://localhost:11434/v1` inside `tlsoc-backend` points at the backend container itself. A
  host Ollama is `http://host.docker.internal:11434` on Docker Desktop, or needs
  `extra_hosts: ["host.docker.internal:host-gateway"]` on Linux. An `ollama` service in an overlay
  (R3) makes it `http://ollama:11434`.

### B4 (medium): no way to describe a source whose severity runs backwards

- `severity_scale_max` is a linear ceiling (`raw / max * 100`). Suricata EVE `alert.severity` 1 is
  the most severe (see section 3), so a Suricata alert with severity 1 projects to the lowest
  severity. There is no inverted ladder.

### B5 (low): the `LITELLM_API_KEY` slot is not forwarded by the base Compose file

- Already documented in `docs/ENVIRONMENT.md`; the key can be set at runtime in the dialog, but
  it lives in memory, so it disappears on restart (same root cause as B2).

---

## 5. Recommendations

Each recommendation keeps the non-negotiables: `decide()` untouched (#3), every model call through
the gateway (#6), aggregates only to models (#7), feed and source values fenced as untrusted (#9),
KV storage only, no new index or table (#12).

### R1. Choose and commit a license (owner decision)

- **What.** Add `LICENSE` and update `README.md`, `docs/releases/known-limitations.md` and
  `ROADMAP.md`. Without one, "nobody else can copy, distribute, or modify your work"
  ([choosealicense.com](https://choosealicense.com/no-permission/)). This is the single blocker to
  "free for the world".
- **Options.** Apache-2.0 (permissive, patent grant, easiest for adoption and for vendors to ship
  connectors) or AGPL-3.0 (keeps hosted forks open, the route Cortex took per its README above).
  The core Python stack is MIT, BSD or Apache (`pip show`: langgraph, langchain-core, SQLAlchemy,
  redis MIT; elasticsearch, tenacity Apache-2.0; orjson Apache-2.0 or MIT); check the connector
  extras (`requirements-connectors.txt`) before choosing.
- **Effort** S. **Value** high. **Risk:** a legal decision only the owner can make; add a `NOTICE`
  if Sigma (DRL) or MISP warninglist data (CC0) is ever bundled.
- **Test.** `scripts/check_docs.py` (or a new check) asserts `LICENSE` exists and the README
  license section names it.

### R2. Fix the `/v1` double path (B1)

- **Where.** `backend/app/llm/providers.py` `_make_openai_compatible` and the custom `base_url`
  branch of `_make_openai`; optionally show the resolved endpoint in the Add dialog.
- **Effort** S. **Value** high. **Risk:** a proxy that really serves `/v1/v1/...` (none known).
- **Test.** As in B1, plus a gateway-level test that a role assigned to a custom model with a
  `/v1` URL produces one successful completion and one `UsageDoc` at $0.

### R3. A free, local-first path from install to the first verdict

- **What to build.**
  1. `deploy/docker-compose.ollama.yml`: an `ollama` service with a named volume,
     `OLLAMA_CONTEXT_LENGTH` set (for example 16384), an optional GPU block, and a one-shot
     `ollama pull` for a chosen model. A separate file is required because the base file's bytes
     are frozen. Document it next to `docker-compose.enrichment-keys.yml`, including that a
     supervised update drops overlays.
  2. Wizard branch "Use a local model (free)" in `webui/src/soc/pages/wizard/RuntimeReviewSteps.tsx`:
     a base URL field, "Fetch models", a model picker, then one call that registers the model
     (`POST /api/llm/models/custom`) and assigns it to the router, investigator, formatter, chat,
     standup and overview roles. A small backend helper (for example
     `POST /api/llm/models/custom/assign-roles`, audited like `model.updated`) keeps it one
     atomic, audited write. `llm/readiness.py` `ai_runtime_status` already treats a reachable
     `openai_compatible` endpoint as callable, so "Ready for live triage" can turn green.
  3. A local embedding option: allow a registered custom model as `embedding_model` (Ollama serves
     `/v1/embeddings`), so retrieval stops depending on the hashing fallback. Embedding-space
     changes already raise `EmbeddingSpaceMismatch` in `tools/vectorstore.py`; reuse that guard.
  4. Context-truncation check in "Test model" (`POST /api/llm/models/test`): send a prompt of
     known size near the role's real prompt size and compare the reported `prompt_tokens`; when
     the server reports far fewer, warn "the endpoint truncated the input; raise
     `OLLAMA_CONTEXT_LENGTH`". This catches Ollama's silent cut (section 3).
  5. JSON mode for the router and investigator on custom models: a per-model `json_mode` flag on
     `CustomModelStore` rows; when set, `OpenAIProvider._chat_payload` adds
     `response_format: {"type": "json_object"}` for `role in {"router", "investigator"}` only. The
     `role` argument already reaches `complete()`, so no signature change is needed. Chat stays
     free text.
  6. Tested presets, not hard-coded defaults: a small documented table of models known to complete
     the offline replay fixtures (for example `gpt-oss:20b`, `qwen3:8b`), with RAM needs from the
     model cards. Keep `gpt-5.6-luna` as the shipped default for people with a key.
- **Effort** M. **Value** high (removes the only paid dependency). **Risks:** small models produce
  weaker verdicts. That is acceptable because `decide()` and the auto-close policy still gate
  every close (#3), and NEEDS_HUMAN never auto-closes; say plainly in the wizard that local models
  route more cases to people. Larger prompts increase memory use.
- **Tests.** Wizard Vitest for the branch (register, assign, readiness green); backend tests for
  the assign helper (audit first, `503 audit_unavailable` leaves nothing written); a payload test
  that `response_format` appears only for flagged custom models and only for the two roles; the
  truncation warning with a stub that under-reports `prompt_tokens`.

### R4. Make per-source secrets restart-safe (B2, B5)

- **Short term (S).** Document `TLSOC_CONNECTOR_SECRETS` (a JSON map, the same shape as
  `connector_secrets`) and `TLSOC_LITELLM_API_KEY` in `.env.example` and `INSTALL.md`, with a
  `deploy/docker-compose.secrets.yml` overlay that forwards them. Add a Sources banner when a
  source in `bearer` or `hmac` mode has no secret in memory (the field names are already in
  `SourceInstance.configured_secrets`), so a post-restart `401` is visible.
- **Proper fix (M).** Optional encrypted persistence of Console-entered secrets in KV (namespace
  `secrets_sealed`), keyed by a new `TLSOC_SECRETS_KEY`. `auth/mfa.py` already has a stdlib
  HMAC-SHA256 keystream (`obfuscate_secret`); a sealed form should add a random salt per record
  and an HMAC tag (encrypt then MAC, separate derived keys) and should get a security review.
  Without the key the behaviour stays as today.
- **Value** high. **Risks:** at-rest secrets widen the blast radius of a database leak; keep it
  opt-in, never export it in `routes_export`, and clear it on factory reset.
- **Tests.** Restart simulation: seal, rebuild `AppState`, the webhook still authenticates;
  wrong key fails closed; the export scopes never contain the namespace.

### R5. One-command install, a doctor, published figures and a lite profile

- **What.**
  1. `scripts/install.sh`: checks prerequisites (Docker, Compose v2, Git, Python 3, `openssl`,
     free ports), clones or checks out the chosen ref, writes `.env` with the secrets INSTALL.md
     already generates with `openssl rand`, asks "local model or provider key", adds the overlays,
     runs `scripts/agentic-soc-compose.sh up --detach --build`, waits on `/api/health/ready` and
     prints the Console URL and the first-administrator step. Non-interactive flags for CI.
  2. `scripts/agentic-soc-compose.sh doctor` (inspection only, so it passes the lifecycle lock):
     ports, health, state backend, model reachability (`ai_runtime_status`), enabled sources and
     secrets present.
  3. Publish measured figures in `INSTALL.md` section 3: measure each container with
     `docker stats` on the reference stack. The idle backend floor measured here is about
     262 MiB; a local model adds its own model-card figure (for example about 16 GB for
     `gpt-oss-20b`).
  4. `deploy/docker-compose.lite.yml`: backend and Console only, `STATE_BACKEND=sqlite` on a
     volume, no Redis (the cache already degrades to memory), no updater. State that the lite
     profile is single-user evaluation and outside supervised updates (DEPLOY.md already lists
     SQLite as "single-node / evaluation / smallest footprint").
- **Effort** M. **Value** high: AiSOC ships `install.sh`, `install.ps1` and `make doctor`, and
  soc-ai ships `setup.sh` with a doctor (section 3).
- **Risks:** an installer that fetches and runs code is a supply-chain surface; publish it only
  from the signed release, pin the ref, and never pipe an unpinned URL to a shell in docs.
- **Tests.** ShellCheck in the existing workflow-policy lane; a dry-run mode tested with
  `scripts/test_*` style Python tests; the CI deploy-contract lane runs `config --quiet` against
  the lite and Ollama overlays.

### R6. Source presets, a Wazuh push script and an inverted severity ladder

- **Presets.** A `presets` list on connector manifests (or a small `connectors/presets.py`) that
  the wizard offers as "I run ..." and that fills index pattern, query filter, field mapping and
  severity ladder:

  | Preset | Connector | Pattern and filter | Mapping highlights | Severity |
  |---|---|---|---|---|
  | Elastic Security alerts | Elastic | `.alerts-security.alerts-*` | `kibana.alert.rule.name`, `kibana.alert.rule.uuid` | `kibana.alert.risk_score`, ceiling 100 |
  | Security Onion alerts | Elastic | `logs-*`, `event.dataset:alert` | ECS | `rule.severity` (verify ladder on a live grid) |
  | OpenSearch Security Analytics | OpenSearch | `.opensearch-sap-*-findings-*` | finding rule fields (verify on a live cluster) | rule severity |
  | Graylog events | OpenSearch | the Graylog events index (verify name) | event definition title, key fields | priority |
  | Wazuh push | Webhook | n/a | `all_fields.*` or the native alert | `rule.level`, `wazuh_0_16` |
  | Suricata EVE | File or webhook | `event_type=alert` | `alert.signature`, `alert.signature_id`, `src_ip`, `dest_ip` | `alert.severity`, inverted |
  | Zeek notice | File | `notice.log` | `note`, `msg`, `src`, `dst`, `uid` | none (use rule mapping) |
  | osquery results | File | `osqueryd.results.log` | `name` as rule, `hostIdentifier` as host | none |

- **Wazuh push.** Ship `deploy/integrations/wazuh/custom-agentic-soc` (Python 3 stdlib, run by the
  Wazuh Integrator) that reads the alert file and posts it to `hook_url`
  (`https://<host>:8088/api/ingest/<source_id>`) with `Authorization: Bearer <api_key>`, a timeout
  and a small retry. Document the `ossec.conf` block (`name`, `hook_url`, `api_key`, `level`,
  `alert_format json`), file mode 750 and owner `root:wazuh`, as Wazuh requires (section 3).
  Accept the built-in `shuffle` wrapper too by mapping `all_fields.*`, but recommend the custom
  script because the built-in one sends no auth header.
- **Inverted ladder.** Add `severity_scale_min_is_max: bool` (or a `severity_ladder` enum) to
  `SourceInstance`, defaulted off so stored configs load unchanged, and apply it in
  `ocsf/model.py` `project_severity_magnitude`.
- **Where.** `backend/app/connectors/*.py` manifests, `backend/app/engine/sample_analysis.py`
  (suggest a preset from a pasted sample), wizard source step, `docs/sources/`.
- **Effort** M. **Value** high (most free users run one of these). **Risks:** index names and
  severity ladders vary by version; each preset needs a "verified against version X" line and the
  pasted-sample check before saving.
- **Tests.** Fixture records for each preset through `generic_to_ocsf` and the ECS path, asserting
  rule, entity, time and projected severity; a Suricata severity 1 projects to the top band; the
  Wazuh script tested offline with a stub HTTP server (argument order, bearer header, non-2xx exit
  code).

### R7. Offline threat intel: warninglists, public MISP feeds, TAXII 2.1, MISP and OpenCTI

- **Shape.** One local IOC store plus feed jobs, and one enrichment provider that reads it.
  - **Store.** `stores/intel_iocs.py` on the shared KV: documents bucketed by a hash prefix of
    `(kind, normalised value)`, for example 4,096 buckets per kind, each a bounded map of
    `value -> {feeds, first_seen, last_seen, valid_until, tags, score}`. A lookup is one `get`.
    A per-feed manifest document records counts, last run, ETag and cursor. Caps per feed and in
    total (for example 250,000 indicators) with a visible "truncated" flag. KV only (#12).
  - **Provider.** `enrichment/providers/local_intel.py`, keyless, default on once a feed exists;
    returns a `ProviderResult` with the matching feed names and tags. Feed text (event titles,
    descriptions, tags) is source-controlled and goes into prompts only through `fence` (#9).
  - **Feeds** (each a durable Job, refreshed by a cadence loop like `engine/campaigns.py`, with a
    row in `AppState.scheduler_health()`):
    1. **MISP warninglists (keyless, CC0).** Fetch the JSON lists from the public repository, or
       let the operator upload the archive. Matching is context only: "8.8.8.8 is in
       `public-dns-v4`". It must never lower risk or close anything by itself; attackers use cloud
       and CDN ranges.
    2. **Public MISP-format feeds (keyless).** Read `manifest.json` and the event files from the
       default list (CIRCL OSINT, Botvrij, DigitalSide and the abuse.ch MISP exports), keeping
       only `to_ids` attributes of supported kinds.
    3. **TAXII 2.1 (OpenCTI and any TAXII server).** A small httpx client: discovery, then
       `GET {api-root}/collections/{id}/objects/` with
       `Accept: application/taxii+json;version=2.1`, `added_after`, `limit`, `next`, and the
       `X-TAXII-Date-Added-Last` fallback for paging ([TAXII 2.1](https://docs.oasis-open.org/cti/taxii/v2.1/taxii-v2.1.html)).
       Parse only STIX `indicator` objects with simple `[ipv4-addr:value = '...']`-style patterns
       and cyber-observables; skip everything else with a counted reason. No `stix2` dependency is
       needed for that subset.
    4. **MISP server.** `POST /attributes/restSearch` with `returnFormat: json`, `to_ids: true`,
       `timestamp` for incremental pulls, `enforceWarninglist: true`, paged.
    5. **Plain lists.** One indicator per line or CSV with a chosen column.
  - **Settings.** Feed URLs are config tier; keys go to the secret tier (R4 applies). Base URLs
    to private hosts are legitimate (self-hosted MISP), so validate scheme only, as
    `routes_models._validate_base_url` does.
- **Effort** M for warninglists and public feeds, M for TAXII and MISP, so L in total.
  **Value** high: free, private (no per-lookup third-party call), and MISP and OpenCTI are what
  free SOCs run. AiSOC already advertises TAXII 2.1 and MISP (section 3).
- **Risks.** Feed poisoning and false positives (keep matches advisory, show the feed name);
  stale indicators (honour `valid_until`, expire on refresh); KV growth (caps and bucket size
  bounds); DRL-style attribution does not apply, but feed terms vary, so show each feed's terms
  link.
- **Tests.** Offline fixtures: a MISP manifest and two event files, a TAXII envelope pair with
  `more`/`next`, a restSearch page, a warninglist with each of the five types (CIDR matching,
  hostname suffix, regex); assertions on caps, expiry, idempotent re-runs, fencing of feed text in
  the investigator prompt, and fail-open on a feed outage.

### R8. Hand a case to DFIR-IRIS or TheHive, and export STIX 2.1

- **What.** Two notification channel types in `backend/app/notifications/webhook.py`:
  - `iris`: `POST {base}/alerts/add` with Bearer, mapping case title, summary, risk band to
    `alert_severity_id` 1 to 6, `alert_source: "Agentic SOC"`, `alert_source_ref: case_id`,
    `alert_source_link` to the Console case, `alert_tags` (MITRE, rule ids),
    `alert_source_content` (the case JSON without spend, as `case_export` already redacts).
  - `thehive`: `POST {base}/api/v1/alert` **(path to verify on a live 5.x)** with `type`,
    `source`, `sourceRef = case_id` (the unique tuple gives idempotency) and observables from case
    entities, skipping empty values (TheHive rejects empty observables, per the
    [Graylog community report](https://community.graylog.org/t/support-request-graylog-thehive-observables-not-extracted-http-400-empty-observables/36918)).
  - Both fire on the existing triggers (escalated, needs human, severity floor) in
    `notifications/dispatch.py`, with its dedup and audit, and from a "Send to IRIS" case action.
  - `GET /api/cases/{id}/export?format=stix`: a STIX 2.1 bundle (`identity`, `observed-data` or
    `indicator` per entity, `sighting`, `note` with the verdict) built with stdlib JSON, for
    MISP or OpenCTI import.
- **Effort** M. **Value** high for IRIS (fully open), medium for TheHive (its Community edition is
  non-commercial and needs a license, section 3).
- **Risks.** This is an outbound write to the operator's own tool, not a response action; keep it
  operator-configured, audited, and never model-initiated. Do not send raw log bodies beyond what
  the case already holds.
- **Tests.** httpx `MockTransport` asserting payload fields, severity mapping, dedup on a retried
  trigger, audit row before send; STIX bundle validated against the 2.1 required properties
  (`type`, `id`, `spec_version`, `created`, `modified`).

### R9. Sigma: import metadata first, a matcher later

- **Phase 1 (M).** "Import Sigma rules" (YAML, a folder or a SigmaHQ release archive) into a KV
  catalog keyed by Sigma `id`: `title`, `description`, `level`, `status`, `author`, `references`,
  `falsepositives`, `tags` (`attack.tXXXX` to `RuleDefinition.mitre`), `logsource`. When an alert's
  rule name or id matches (Wazuh, Elastic, OpenSearch Security Analytics and Security Onion all run
  Sigma-derived rules), the rule sheet (`routes_rule_summary.py`) shows the rule's description and
  known false positives with the author credit the DRL requires, and the investigator receives
  `falsepositives` inside an untrusted fence (#9). PyYAML is already installed transitively by
  `langchain-core`; pin it explicitly if used directly (a deliberate dependency decision).
- **Phase 2 (L).** Evaluate Sigma detections over OCSF events in the EVENT funnel's rules pass
  (`engine/event_detection.py` `_rule_fires`) through a small evaluator for the common modifiers
  (`contains`, `startswith`, `endswith`, `re`, lists, `all`, conditions with `and`, `or`, `not`,
  `1 of`), or through pySigma with the OCSF pipeline (a new dependency and a license check).
  `RuleMatch` stays as it is.
- **Value** medium. **Risks:** DRL attribution in every match view; many Sigma rules target
  Windows log sources a given user does not ingest (show "no matching data" honestly); phase 2 must
  stay a pure producer that never calls `decide()`.
- **Tests.** Parse a fixture set of SigmaHQ rules; attribution rendered wherever a matched rule is
  shown; phase 2 truth tables per modifier.

### R10. Documentation: a free stack in an afternoon

- **What.** New pages under `docs/sources/` and `docs/getting-started/`:
  - "A free SOC stack": Wazuh (agents and Integrator push), Suricata, Agentic SOC with Ollama,
    DFIR-IRIS for cases, MISP warninglists and public feeds; one diagram, one host, with honest
    RAM figures from the vendors (Wazuh 8 GiB, Security Onion Eval 8 GB, model card figures).
  - One recipe per tool in section 3, each with the exact config block, the preset to choose, a
    test alert and the expected case.
  - "Choosing a local model": hardware tiers, `OLLAMA_CONTEXT_LENGTH`, the truncation warning,
    what to expect from small models.
  - Regenerate the Help Center chat corpus (`npm run gen:console-map`, then
    `scripts/build_app_knowledge.py`) so chat can answer these questions.
- **Effort** S to M. **Value** high. **Risk:** drift; tag each recipe with the tool version tested.
- **Tests.** `scripts/check_docs.py`, `docs:check`, and `build_app_knowledge --check`.

### R11. CVE context: CISA KEV and EPSS

- **What.** Add `IndicatorKind.CVE` (`constants.py`), extract `CVE-\d{4}-\d{4,}` from rule and
  vulnerability fields (Wazuh vulnerability detector, Suricata references), and two keyless
  providers: KEV from the JSON feed or its GitHub mirror ([cisagov/kev-data](https://github.com/cisagov/kev-data)),
  refreshed daily into KV; EPSS from FIRST **(API terms and rate limits unverified)**.
- **Effort** M. **Value** medium. **Risk:** a new indicator kind touches dispatch, aggregation and
  the UI chips; keep it additive.
- **Tests.** Fixture KEV file, extraction regex cases, provider fail-open.

### R12. Community runbooks

- **What.** A bulk import Job for a `.zip` of Markdown runbooks (each lands as a Draft through the
  existing `catalog.import_plan`, with notes), a `community-runbooks` repository or folder with a
  contribution guide (front matter, `applies_when`, ATT&CK ids, references, a review), and a
  matching CI check that runs the runbook validator on contributions.
- **Effort** M. **Value** medium. **Risk:** imported text is untrusted until Published (#9 is
  already enforced: the investigator reads only Published text).
- **Tests.** Zip with valid, invalid and clashing ids; audit rows; Demo Mode refusal.

### R13. Cortex bridge provider

- **What.** `enrichment/providers/cortex.py`: base URL (config) and key (secret), a list of
  analyzer names per indicator kind, submit a job, poll the report with a bound, fail open; results
  cached through the existing Redis path (#8).
- **Effort** M. **Value** medium (only for Cortex users). **Risk:** analyzer latency; keep a strict
  timeout and run outside the investigator's critical path where possible.
- **Tests.** Stub server for submit, poll and report; timeout path.

### R14. A read-only MCP server

- Already in `ROADMAP.md`. In this ecosystem it matters because Open WebUI and Ollama users wire
  tools through MCP (the Wazuh MCP servers in section 3). Expose the chat tools in
  `agents/chat_tools/` read-only under the caller's grants, with all outputs treated as untrusted
  by the client. **Effort** L. **Value** medium. Not for this round.

### R15. Try it without a toolchain

- **What.** `deploy/docker-compose.demo.yml` (backend with in-memory state, Console, a one-shot
  container that calls `POST /api/demo/enable` like `scripts/run-demo.sh` does, bound to
  `127.0.0.1`), and a `.devcontainer/` for Codespaces.
- **Effort** S to M. **Value** medium. **Risk:** the demo credential must stay local-only, as
  `DEMO.md` already warns.
- **Tests.** Deploy-contract lane runs `config --quiet` on the demo file; a smoke test of the
  enable call.

---

## 6. Suggested Round 16 slice from this report

Within a round already focused on the operator's interface asks, the ecosystem items that fit:

1. R1 as a decision for the owner (no code).
2. R2, the `/v1` fix, with its path test.
3. R4 short term (document and overlay `CONNECTOR_SECRETS`, the missing-secret banner).
4. R6 presets for Elastic Security, Wazuh push (with the Integrator script), Suricata EVE (with the
   inverted ladder) and Security Onion.
5. R3 items 1, 2 and 4 (Ollama overlay, wizard local branch, truncation check).
6. R10 pages for the items shipped.
7. R7 warninglists only, if capacity remains.

---

## 7. Journal entry (for the orchestrator to append)

```
### 2026-11-24 00:00Z - research sub-agent (oss-ecosystem) - Round 16 free and open-source ecosystem research
- Context: Round 16 discovery; what would make Agentic SOC the ideal free, self-hosted agentic SOC.
- Did: read-only survey of connectors, receivers, enrichment providers, custom models, runbooks,
  deploy and INSTALL.md; external research on Wazuh, Security Onion, TheHive, Cortex, DFIR-IRIS,
  Shuffle, OpenCTI, MISP, Velociraptor, Sigma, Zeek, Suricata, osquery, Graylog, OpenSearch
  Security Analytics, the Elastic free tier, Ollama, vLLM and two competitors. Found: an
  OpenAI-compatible base URL ending in /v1 calls /v1/v1/chat/completions (scratch probe, 404);
  per-source secrets are not restart-safe in Compose (CONNECTOR_SECRETS not forwarded); no inverted
  severity ladder for Suricata; no LICENSE file. Measured idle backend RSS about 262 MiB on SQLite.
  Report: scratchpad round16/research/oss-ecosystem.md with 15 ranked recommendations.
- Tests: none run against the suite (read-only research); two scratch probes only.
- Status: done.
- Next: owner license decision; fix the /v1 path with a request-path test; presets plus Wazuh push
  script; local-model wizard branch and Ollama overlay.
```
