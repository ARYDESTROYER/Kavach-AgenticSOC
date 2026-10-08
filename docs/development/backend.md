---
title: Backend development
description: Agentic SOC API architecture, conventions, configuration, routes, persistence, and local workflow for version 0.1.
---

# Backend development

The Agentic SOC API is an asynchronous Python application built with FastAPI, Pydantic v2,
and LangGraph-compatible agent orchestration. The application entry point is
`backend/app/main.py`; startup constructs one `AppState`, loads the selected state
backend, initializes services, and starts configured background workers.

## Set up the backend

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

Run the API in development with:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8088 --reload
```

The base configuration has authentication off. Set explicit environment values when
testing auth, state backends, or real providers; never place real credentials in a
tracked file.

## Backend layers

```text
api routes
  -> application services / AppState
    -> connectors -> OCSF -> correlation/risk -> agents -> case manager
    -> repositories / selected state backend
    -> LLM gateway / usage ledger
    -> enrichment, RAG, notifications, realtime events
```

| Package | Role |
|---|---|
| `api/` | HTTP models, dependencies, base routes, and auto-discovered feature routers |
| `connectors/` | Pull and receiver SPIs, manifests, registry, and built-ins |
| `ocsf/` | OCSF event model plus generic/ECS normalization |
| `engine/` | Deterministic correlation, risk, decision, polling, tuning, campaigns, baselines, budgets, and reports |
| `agents/` | Router, investigator, formatter, chat (the agent loop, its protocol parser, stream events, answer blocks, and the `chat_tools/` read-only tool registry), standup, prompts, and pipeline |
| `llm/` | Provider adapters, retry behavior, batching, pricing, and the single gateway |
| `tools/` | MCP-shaped read-only investigation tools |
| `knowledge/` | The generated Help Center corpus and console map, verified by a manifest, plus the dependency-free search behind chat's product answers |
| `stores/` | Repository interfaces plus Elasticsearch, SQL, and KV-backed implementations |
| `auth/`, `rbac/` | Password/JWT/MFA/OIDC services and permission policy |
| `notifications/`, `enrichment/` | Pluggable outbound channels and threat-intelligence providers |

## Models and configuration

Use Pydantic v2 models for request, response, stored, and preference contracts.
Persist JSON-compatible values with `model_dump(mode="json")`. Additive stored-model
fields need defaults so earlier documents continue to load.

`Secrets` contains environment/process values. `Preferences` contains validated,
non-secret, state-backed settings. A new non-secret setting normally requires:

1. a defaulted field in `Preferences` or a nested configuration model;
2. validation and migration behavior when existing state needs it;
3. a Console control or documented API path;
4. tests covering serialization, update, and behavior.

Never add a credential to `Preferences`. See the
[Configuration reference](../reference/configuration.md).

## API routers and authorization

The base router lives in `app/api/routes.py`. A self-contained feature belongs in a
module named `app/api/routes_<feature>.py` that exports a top-level
`router: APIRouter`. Startup discovers those modules in sorted order and fails loudly
if a feature module cannot import or omits its router.

Every `/api` router receives the central authentication dependency. Each protected
state-changing operation must also declare the narrow
`require_permission(resource, action)` gate, plus fresh-auth enforcement for sensitive
operations where appropriate. Bootstrap, login, and self-authenticating receiver paths
need explicit, narrowly tested exceptions. Add a public route only by deliberately
extending the small allowlist in `api/deps.py` and adding security tests.

Prefer typed request bodies and explicit response models. Existing 0.1 endpoints with
plain dictionary responses remain valid, but new response models improve the OpenAPI
contract and generated client types.

## Persistence

Application code depends on repository interfaces rather than a concrete database.
The selected state backend supplies cases, usage, audit, configuration, cursors, KV
documents, and vector storage.

- Elasticsearch uses dedicated Agentic SOC indices and aliases.
- PostgreSQL and SQLite share the asynchronous SQLAlchemy repository layer.
- Feature stores commonly use a namespaced KV document to avoid unnecessary schema
  migrations.
- Audit records are append-only; do not add mutation/deletion to that interface.

For concurrent KV updates, use the provided mutation helper instead of a hand-written
load/modify/save cycle. Preserve idempotent case signatures and durable cursor
semantics across every backend.

## Agent and decision boundaries

Call a model only through `llm/gateway.py`. The gateway is the one place that records
usage and cost. Prompt content derived from sources, users, cases, or arbitrary
knowledge must use the shared untrusted-data fencing helpers.

Do not allow an agent, tool, playbook, notification, or preview endpoint to write a
final case decision. `engine/case_manager.py` remains the authority. Provider, source,
tool, or parsing failures must preserve a case and route to human review.

## Code conventions

- Begin Python modules with `from __future__ import annotations`.
- Use full type hints and asynchronous I/O.
- Keep module-level side effects minimal; optional dependencies load lazily.
- Use deterministic sorting where filesystem/registry order could vary.
- Redact secrets and bound untrusted text before logs, audit excerpts, or UI responses.
- Avoid adding a runtime dependency when the standard library or an existing package
  already provides the required behavior.

Continue with [Extensions](extensions.md), [API reference](../reference/api.md), and
[Testing](testing.md).
