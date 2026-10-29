---
title: Development
description: Repository orientation, contribution flow, invariants, and development entry points for Agentic SOC 0.1.
---

# Development

Agentic SOC 0.1 is developed as one repository containing the
Agentic SOC API, Agentic SOC Console, deployment assets, and versioned documentation.

## Contribution flow

Use a short-lived feature branch, merge accepted work into `Testing`, and promote
the accepted source tree through a protected pull request to `main`, the Stable branch:

```text
feature branch -> Testing -> main (Stable) -> v0.1.13
```

Do not develop directly on `main`. `Testing` is the integration and acceptance
channel, not a different edition of the product. Package/API/image metadata uses
Semantic Version **0.1.13**; public documentation uses the **0.1** line.

The remote uses `Testing` for integration and default `main` for accepted Stable
source. Version 0.1.13 is Stable only when the exact verified `main` commit has the
immutable `v0.1.13` tag and matching signed/public artifacts. Repository owners
must independently verify pull-request protection, required checks, and release-
environment policy; source topology alone does not prove that a change passed
acceptance.

The immutable `v0.1.10` tag is a failed-publication record, not an installation
source: its release job timed out before the complete signed three-image set,
canonical plan/bundle, GitHub Release, Stable tags, and Stable Help Center existed.
Never move, reuse, repair, install, or bootstrap from that tag.

See [Release channels](../releases/channels.md) for the promotion contract.

## Repository map

| Path | Responsibility |
|---|---|
| `backend/app/` | FastAPI application, agents, deterministic engine, connectors, OCSF, auth, stores, notifications, and provider integrations |
| `backend/tests/` | Offline backend regression and contract tests |
| `backend/app/runbooks/library/` | The 12 built-in runbooks (package data) |
| `webui/src/` | React/TypeScript Agentic SOC Console |
| `webui/src/design-system/` | Cross-cutting loading feedback, source assets, and machine-readable Console catalog |
| `webui/scripts/` | Design gates and OpenAPI/type-generation tooling |
| `deploy/` | Standalone and legacy-merge Compose definitions |
| `docs/` | Public MkDocs documentation and source content |
| `overrides/` | MkDocs Material template overrides |
| `archive/` | Frozen legacy components; not part of current development |

The archived Kibana plugin is not built, tested, or shipped. New UI work belongs in
`webui/`.

## Local toolchain

- Python 3.11+ for the backend;
- Node 22 for the Console;
- a Python virtual environment with backend development requirements;
- npm dependencies installed from the committed lockfile;
- optional Docker/Compose for deployment-shape validation.

Start with [Backend development](backend.md) or [Console development](webui.md).
Before changing any routed Console page or shared shell component, read the current
[Console UI standard](ui-standard.md); it is the enforceable migration contract, while
older round-specific design documents are historical rationale. Use the
[Console design system](design-system.md) for the canonical implementation layers,
public imports, asset rules, loading states, and future agent-tooling boundary.

## Architecture rules for every change

- Telemetry-source credentials are least-privilege and read-only.
- Every recorded action remains append-only in the audit repository.
- The LLM recommends a verdict; deterministic code owns close/escalate decisions.
- Polling cursors and case signatures preserve no-skip/no-duplicate behavior.
- All LLM calls pass through the single gateway and cost ledger.
- Standup/model summaries aggregate before sending content to a model.
- Enrichment remains cached and fail-open.
- Attacker-influenceable content is fenced as untrusted before any prompt.
- New behavior ships with working defaults and degrades toward human review.

These are product properties, not implementation suggestions. Tests should lock them
down whenever a change touches the relevant boundary.

## Typical change sequence

1. Identify the owning backend model/route/store and the Console surface.
2. Add or adjust the backend contract with defaults that load existing state.
3. Add authorization to every state-changing endpoint.
4. Regenerate the committed OpenAPI snapshot and generated TypeScript types.
5. Update the hand-maintained domain types and Console client if the response shape changed.
6. Add backend and frontend regression tests.
7. Run the relevant test, lint, type, design, build, version, and docs gates.
8. Update public documentation for behavior visible in version 0.1.

Read [Extensions](extensions.md) before adding a connector, provider, channel, tool,
route family, or persistence implementation. Use [Testing](testing.md) for the
verification matrix.
