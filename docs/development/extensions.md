---
title: Extension points
description: Add connectors, enrichment providers, notification channels, LLM providers, tools, routes, runbooks, and stores to Agentic SOC 0.1.
---

# Extension points

Agentic SOC exposes small registries and interfaces for source, intelligence, delivery, and
model integrations. Extensions must preserve read-only source access, untrusted-data
fencing, deterministic decisions, complete audit/cost accounting, and fail-safe human
review.

## Connectors

A connector subclasses one of the contracts in `app/connectors/base.py`:

- `PullConnector` implements reachability, durable-cursor polling, source-neutral
  structured search, and ID fetches.
- `PushReceiver` implements lifecycle/parsing for a listener, queue, stream, or
  object-store source and emits normalized batches.

Every connector provides a static `ConnectorManifest`. Its source identity,
capabilities, ingest modes, configuration fields, secret fields, setup help, and
optional dependencies drive the first-run UI. Secret fields must be marked as such so
only configured status is persisted or displayed.

Normalize every record to OCSF. Map known fields, retain unknown values in `unmapped`,
and preserve the original record in `raw_data`; both remain untrusted. Pull connectors
compile `StructuredQuery` to their native dialect rather than accepting raw model-
generated DSL.

Built-ins register in the connector registry. An external package can expose a
connector class through the `tlsoc.connectors` Python entry-point group. Optional SDKs
must import lazily at runtime and return an actionable missing-dependency error.

Test the manifest, normalization, auth, cursor boundary, duplicate handling, and
failure behavior without a live vendor service.

## Enrichment providers

Subclass `EnrichmentProvider`, set a stable `name`, and implement:

- a class-level `ProviderManifest` declaring indicator kinds, toggle key, secret
  fields, documentation, and default enablement;
- `_lookup(value, kind)` returning one `ProviderResult`.

Do not override the public `lookup` wrapper: it converts every provider exception into
a fail-open result. The registry calls a provider only when it handles the indicator,
is enabled, and has its required key. Results remain Redis/in-memory cached by the
dispatch path.

External packages register provider classes under `tlsoc.enrichers`.

## Notification channels

Subclass `NotificationChannel`, provide a stable lowercase `type`, and implement
`send(NotificationEvent) -> SendResult`. Delivery must never raise into the case
pipeline. Return a short redacted detail; never include a token, password, destination
URL, or routing key.

Templates produce escaped/fenced text before delivery. A channel may format a
structured payload from safe scalar projections but must not re-inject raw case or log
content into HTML. Register built-ins with `register_channel`; external packages use
the `tlsoc.channels` entry-point group.

## LLM providers

Provider factories live behind the single gateway. An external provider entry point
under `tlsoc.llm_providers` may expose either:

- a `(name, factory)` pair; or
- a callable factory with a `provider_name` attribute.

The factory returns the provider adapter, but it must not write a usage record. The
gateway remains the sole ledger writer and applies retry/accounting behavior. Add a
provider to the validated configuration vocabulary and secret-status surface before
making it selectable.

## Investigation tools

A tool implements the MCP-shaped `Tool` contract: stable name, description, JSON
input schema, capability tier, and asynchronous `run`. Register the instance in the
application tool registry.

Return a `ToolResult` with a bounded summary, structured data, error, and reproducible
query metadata where relevant. Source access remains read-only. Treat tool output as
untrusted prompt content. A future mutating/outward tool must use `MANAGED` or
`REQUIRES_APPROVAL`; a forbidden autonomous action must remain `FORBIDDEN`.

## Feature routers

Create `app/api/routes_<feature>.py` with a top-level `router: APIRouter`. Startup
discovers feature routers automatically in sorted order. Add request/response models,
central auth, resource/action permission dependencies, and tests. Do not add manual
router registration in `main.py`.

After changing the API contract, regenerate and commit the OpenAPI snapshot and
generated Console types:

```bash
cd webui
npm run gen:types
```

## Preferences and state stores

A new non-secret preference belongs in a defaulted Pydantic configuration model and
round-trips through `/api/settings`. Credentials belong in `Secrets` and configured-
status responses, never preferences.

Prefer existing repository/KV abstractions. A new shared feature document can often
use the namespaced `KVStore` without a table or index. Use the common atomic mutation
helper for read-modify-write behavior. If a new repository is necessary, define the
interface first and implement equivalent behavior for every supported state profile
or make the compatibility restriction explicit.

## Runbooks

Runbooks are content, not executable code: phased procedures of Check, Lookup, Decision,
Action and Record steps, defined by `engine/runbook_model.py` and written in the
Markdown format described in [Runbooks](../intelligence/runbooks.md). They recommend and
record; they never close or escalate a case, and nothing in the runbook modules may call
or change `case_manager.decide()` or the auto-close policy.

- **Built-in runbooks** are package data under `backend/app/runbooks/library/` (12 files),
  read only and versioned by the release. To ship a new one, add its Markdown file there,
  keep its investigator guidance within the 3,000-character budget (a test checks each
  bundled runbook), and give it an Applies when that does not shadow an existing one.
- **Operator runbooks** live in the `runbook_library` key-value namespace and are written
  only through the library API (`/api/runbooks*`), which validates, records every change
  in the audit log before it is saved, and keeps Draft, In review, Published and Retired
  versions. Do not add another write path: only Published text may reach the
  investigator or the knowledge index as trusted context.
- **Lookups** run read-only tools with case values passed as parameters, never written
  into query text. A new lookup tool needs a read-only implementation, a grant in
  `LOOKUP_TOOL_GRANTS`, bounded results, and untrusted-data rendering.
- **Matching** is deterministic and free (`engine/runbook_match.py`); it never calls a
  model.

The earlier procedure modules and their stores are gone; a guard test fails if any
module imports them again (see [Testing](testing.md#round-14-guards)). Operator-imported
knowledge documents stay on the untrusted retrieval path.

## Extension acceptance checklist

- Discovery failure cannot break application startup unless the extension is a core
  feature router whose absence would silently remove protected functionality.
- Optional dependencies are lazy and the base import/test suite still works.
- Secrets are never returned, persisted as preferences, or logged.
- Untrusted inputs are bounded and fenced before model use.
- Errors preserve the case and fail toward human review.
- All LLM usage is ledgered and every action is audited.
- Backend, Console, generated-contract, version, and documentation gates pass.
