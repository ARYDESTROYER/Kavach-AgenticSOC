---
title: Quickstart
description: Choose an Agentic SOC 0.1 checkout, run the deterministic demo, or bring up the standalone evaluation stack.
---

# Quickstart

Use the deterministic demo to explore the analyst workflow without an external
source or provider bill. Use the Compose stack when you are ready to evaluate a
real source with persistent application state.

!!! info "Choose the matching channel"

    `Testing` contains integrated candidates. Under the release contract, `main`
    holds only accepted Stable source and immutable `v0.1.13` identifies this candidate.
    The remote has both canonical branches. Use `v0.1.13` only when its signed GitHub
    Release and public digest-pinned images verify and canonical PostgreSQL Compose
    runtime acceptance completes, and use `Testing` only for an unreleased preview.
    Repository administrators must verify branch protections and required checks
    independently.

??? note "Never install from v0.1.4 to v0.1.12"

    These immutable tags are non-installable history and must never be recommended.

    - `v0.1.4` and `v0.1.5`: failed-publication records without a canonical signed plan
      and public GitHub Release.
    - `v0.1.6`: its signed, public artifact set is valid, but canonical macOS Bash 3.2
      acceptance failed before supervisor installation. Never bootstrap from it.
    - `v0.1.7`: it could not publish the private control socket under dropped
      capabilities.
    - `v0.1.8`: it reached signed-plan verification, but cosign's default TUF cache was
      unwritable beneath the read-only root filesystem.
    - `v0.1.9`: it corrected that cache location, then failed when the constrained
      supervisor could not traverse the runner-owned verification directory. It has no
      installable GitHub Release.
    - `v0.1.10`: it fixed that traversal boundary, but its signed-release job timed out
      while the architecture-neutral Web Console builder ran under target emulation.
    - `v0.1.11`: it passed all image and plan verification, including inside the
      constrained updater, but its post-verification cleanup failed before canonical
      Release publication.
    - `v0.1.12`: it completed the entire signed, public release, but canonical v0.1.1
      bootstrap failed closed before application mutation because matching absent legacy
      state-schema labels were normalized asymmetrically.

## Get the source

=== "Testing"

    ```bash
    git clone --branch Testing https://github.com/ARYDESTROYER/Kavach-AgenticSOC.git
    cd Kavach-AgenticSOC
    ```

=== "Stable 0.1.13 (after acceptance)"

    ```bash
    git clone https://github.com/ARYDESTROYER/Kavach-AgenticSOC.git
    cd Kavach-AgenticSOC
    git checkout v0.1.13
    ```

    The `v0.1.13` tag is absent before publication and immutable afterward; do not
    create, move, or replace it locally. Users pulling `main` receive the current
    accepted Stable source, while candidate work remains isolated on `Testing`. A branch
    name alone is not acceptance evidence, so repository administrators must verify
    protections and required checks. If the signed Release, public image evidence, or
    canonical runtime acceptance is missing, use a previously verified Stable release.

Keep a full clone (no `--depth 1`): the one-time updater bootstrap checks that the
release commit is contained in `origin/main`, which a shallow single-branch clone lacks.

## Option A: deterministic demo

The demo uses generated multi-source security stories and a deterministic `$0`
mock model. It exercises the real parsing, OCSF, correlation, case, and audit paths
without contacting a model provider or upstream security system.

### Requirements

- Python 3.11
- Node.js 22 and npm
- macOS or Linux with Bash

```bash
./scripts/run-demo.sh
```

The script starts the backend on port `8088` with sign-in enabled and the Console dev
server on port `5173`, then completes setup for you. Open `http://127.0.0.1:5173` and
sign in with the demo-only account printed by the script. In the standard seed it is
`Admin` / `Admin@123`. Stop both processes with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

!!! warning "Demo credentials are not deployment credentials"

    Never expose the demo account or reuse its password with real data. Demo Mode
    isolates triage and forces the mock provider, but organization settings you
    deliberately change remain real configuration.

### What you see first

The first page is the **Cyber Defence Center**, already populated with synthetic
activity. A badge in the header marks the workspace as a demo. Select a screenshot to
open it full size.

<figure markdown="span">
[![Agentic SOC Cyber Defence Center dashboard in light mode with case KPIs, a noise reduction flow from alerts to cases, and a human versus AI chart.](../assets/screenshots/hero-overview-light.webp#only-light) ](../assets/screenshots/hero-overview-light.webp)
[![Agentic SOC Cyber Defence Center dashboard in dark mode with case KPIs, a noise reduction flow and a human versus AI chart.](../assets/screenshots/hero-overview-dark.webp#only-dark) ](../assets/screenshots/hero-overview-dark.webp)
<figcaption>The Cyber Defence Center with synthetic activity. Partial coverage appears because the demo's durable alert counters started less than 24 hours before the capture.</figcaption>
</figure>

Continue with [Demo Mode](demo.md) for story generation, seeded mode, and reset
behaviour, or [Your first case](first-case.md) for the analyst walkthrough.

## Option B: standalone stack

The standalone deployment contains PostgreSQL + pgvector for Agentic SOC state, Redis
for enrichment caching, the FastAPI backend, the nginx-served Agentic SOC Console, and
the private update supervisor. Your SIEM or event source is connected separately and is
not modified. [Install Agentic SOC](install.md) shows the full topology.

### Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose`)
- Git, Bash, and Python 3 on the host (the Compose wrapper script uses Bash and Python 3)
- an Anthropic/OpenAI key or a reachable OpenAI-compatible model, unless you keep
  triage in Demo Mode
- a least-privilege read-only credential for each pull source

### Configure

```bash
cp .env.example .env
```

Set unique values for the database password, JWT signing secret, and an environment
administrator:

```dotenv
TLSOC_PG_PASSWORD=<random-database-password>
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret-at-least-32-bytes>
TLSOC_AUTH_ADMIN_USERNAME=admin
TLSOC_AUTH_ADMIN_PASSWORD=<unique-admin-password>

# Configure one provider, or register a compatible local model after setup.
TLSOC_ANTHROPIC_API_KEY=
TLSOC_OPENAI_API_KEY=
```

Generate random values with `openssl rand -hex 32`. Do not commit `.env`. Set
`TLSOC_AUTH_COOKIE_SECURE=true` when TLS terminates in front of the console.

With `TLSOC_AUTH_ADMIN_PASSWORD` set, the backend does not seed the demonstration
`Admin` account, and the Console opens on **Create your admin account**, where you
create a named administrator. The environment administrator remains a fallback sign-in.
Leave `AGENTIC_SOC_UPDATE_REPOSITORY` as `.env.example` ships it: it names the repository
whose signed releases the update supervisor trusts, not the clone URL.

### Validate and start

```bash
./scripts/agentic-soc-compose.sh config --quiet
./scripts/agentic-soc-compose.sh up --detach --build
./scripts/agentic-soc-compose.sh ps
```

Open `http://localhost:8080`, then verify the public probes:

```bash
curl --fail http://localhost:8080/api/health/live
curl --fail http://localhost:8080/api/health/ready
curl --fail http://localhost:8080/api/health/build-info
```

- **Live** confirms the API process is running.
- **Ready** confirms the configured application-state store is usable; an
  unavailable dependency returns HTTP `503`.
- **Build info** reports version and build identity without exposing secrets.

Open **Help Center** from the bottom of the Console rail and verify it opens the
same-origin `/docs/0.1/` Help Center. This installed guide is the operator authority
for the running build; public Stable/Development material is secondary.

Complete [first-run setup](first-run.md), then follow [Install Agentic SOC](install.md)
for topology, production ingress, and provider options.

## Connect one narrow source

1. Open **Sources**, choose **Add source**, and select a connector.
2. For a pull source, use a credential limited to read and metadata access on one
   test index or feed. Never use a superuser or service-system account.
3. Set a narrow data scope and map the source fields.
4. Use **Test connection** where the connector supports it, then save. Once the source
   is saved, you can paste a representative non-sensitive record into **Paste a sample
   record (optional)** and select **Suggest mappings**; the sample is not persisted.
5. Send or expose one synthetic alert and confirm its timestamp, rule, severity,
   entities, source identity, and raw provenance in **Logs** and **Cases**.
6. Widen the scope only after the normalized record and resulting case are correct.

HTTP receivers accept supported JSON, NDJSON, CEF, LEEF, GELF, syslog, or key/value
payloads at:

```text
POST /api/ingest/<source-id>
```

The sender must retry non-success responses. UI-supplied source secrets are a
runtime secret tier and must be re-entered after a backend restart; environment
secrets remain the durable deployment tier.

## Verify the workflow

- **Sources** shows configuration and health signals.
- **Logs** shows normalized records and source attribution.
- **Cases** separates source facts, investigator findings, and policy decisions.
- **Cost** records each model call through the single gateway.
- **Audit log** records state-changing analyst and agent actions.

The screenshots below come from the demo. On **Sources**, each connected source shows
its type, status, enabled switch, last event, and protocol.

<figure markdown="span">
[![Sources page listing five connected demo sources, all ready and enabled, with source counts and alert totals above.](../assets/screenshots/sources.webp) ](../assets/screenshots/sources.webp)
<figcaption>Sources in the demo: five connected sources, all ready.</figcaption>
</figure>

In **Case Manager**, a case's Investigation tab shows the **Decision** card, labelled
**Code**, above the **AI assessment**, labelled **AI** and marked advisory. The close or
escalate decision is made by deterministic code against the operator policy, never by
the model.

<figure markdown="span">
[![Case Manager with an escalated true-positive case selected: the Decision card, labelled Code, records why code escalated it, and the advisory AI assessment below gives the model's reading and confidence, above the investigation inputs.](../assets/screenshots/case-manager.webp) ](../assets/screenshots/case-manager.webp)
<figcaption>Case Manager: the code decision above the advisory AI assessment.</figcaption>
</figure>

## Stop

```bash
./scripts/agentic-soc-compose.sh down
```

The named PostgreSQL volume remains. Adding `--volumes` deletes that state and is
not reversible; use the documented [reset controls](../administration/reset.md)
when you need a scoped, audited reset.

Before internet exposure, review [security](../operations/security.md),
[health and backup](../operations/health-backup.md), and
[known limitations](../releases/known-limitations.md).
