---
title: Install Agentic SOC
description: Start the recommended Agentic SOC 0.1 evaluation stack and verify its public health checks.
---

# Install Agentic SOC

This guide applies to **Agentic SOC 0.1** and is for operators installing the recommended
self-contained evaluation stack. It runs PostgreSQL with pgvector, Redis, the Agentic SOC
API, and the nginx-served Agentic SOC Console. Your SIEM or event source remains separate
and read-only.

## Prerequisites

- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose`)
- enough local capacity for four containers and the state volume
- an Anthropic or OpenAI key, or a reachable OpenAI-compatible model, for real
  investigations
- a least-privilege credential if you plan to add a pull source

The deterministic demo does not require a provider key. See [Run the demo](demo.md)
when infrastructure and external model calls are not part of your evaluation.

## 1. Check out version 0.1

After its complete signed publication and canonical runtime acceptance succeed, use
the immutable `v0.1.13` Stable tag:

```bash
git clone --branch v0.1.13 --depth 1 \
  https://github.com/ARYDESTROYER/Agentic-Kibana.git
cd Agentic-Kibana
```

For an unreleased preview, use the repository's `Testing` branch instead. The remote
uses default `main` for accepted Stable source. Do not create or move a release tag
locally. Pulling `main` means pulling the current
accepted Stable source—not the next Testing candidate—but repository protections
and required checks must be verified independently.

The immutable `v0.1.4` and `v0.1.5` tags are not installable releases: their
publication attempts stopped before a canonical signed plan and public GitHub
Release existed. The immutable `v0.1.6`, `v0.1.7`, and `v0.1.8` publications have signed/public
artifacts but failed canonical bootstrap acceptance at different portability
boundaries. The immutable `v0.1.9` publication built, signed, and anonymously proved
all three images, but its constrained supervisor could not traverse the runner-owned
verification directory and no GitHub Release or installable plan was published. The
immutable `v0.1.10` workflow later timed out while its Web Console builder ran under
target emulation; it also has no installable GitHub Release or canonical signed plan.
The immutable `v0.1.11` workflow built, signed, anonymously proved, and verified all
three images and the plan but failed during post-verification cleanup before its
canonical Release or assets were published. The immutable `v0.1.12` release then
completed the entire signed/public publication, but canonical v0.1.1 bootstrap
failed closed before application mutation because matching absent legacy
state-schema labels were normalized asymmetrically. These records must never be
used as installation sources. Use `v0.1.13`
only when its canonical GitHub Release, plan
signature, public image digests, and canonical PostgreSQL Compose runtime acceptance
all verify. Otherwise use a
previously verified Stable release or Testing only for an explicitly
unreleased evaluation.

Version 0.1.13 retains the writable updater trust cache and least-privilege verification
assets, and moves only architecture-neutral Console builder work to BuildKit's native
platform. The final nginx runtime remains target-platform-specific. It also restores
the runner-owned verification fixture to private mode only after verifier exit. It changes no
schema, protocol, identity, privilege, trust predicate, or frozen-base bytes.

## 2. Prepare configuration

```bash
cp .env.example .env
```

At minimum, set a database password and stable authentication secret. Enable the
built-in authentication layer for any shared evaluation:

```dotenv
TLSOC_PG_PASSWORD=<random-database-password>
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=<stable-random-secret-at-least-32-bytes>

# Choose one for non-demo investigations, or configure a compatible local model:
TLSOC_ANTHROPIC_API_KEY=
TLSOC_OPENAI_API_KEY=
```

Generate random values with `openssl rand -hex 32`. Never commit `.env`.

!!! warning "Secrets entered later in the UI"

    In Agentic SOC 0.1, runtime-entered source, notification, SSO, and local-model secret
    values live in process memory. They must be re-entered after a backend restart.
    Environment or an external deployment secret mechanism is the durable boot-time
    path.

## 3. Validate and start

```bash
./scripts/agentic-soc-compose.sh config --quiet
./scripts/agentic-soc-compose.sh up --detach --build
./scripts/agentic-soc-compose.sh ps
```

Open `http://localhost:8080` for a workstation evaluation. Terminate TLS at a trusted
ingress and set secure cookies before exposing the deployment beyond a trusted
network.

## 4. Verify the API

```bash
curl --fail http://localhost:8080/api/health/live
curl --fail http://localhost:8080/api/health/ready
curl --fail http://localhost:8080/api/health/build-info
```

- **Live** confirms the API process is running.
- **Ready** confirms the configured application-state store can serve requests.
- **Build info** reports the product version and build metadata without secrets.

Open **Help Center** from the bottom of the Console rail and confirm the browser
stays on this deployment at `/docs/0.1/`. That bundled Help Center matches the
installed application and remains usable without access to GitHub or the public docs
site.

If readiness fails, inspect the backend service logs and use the
[troubleshooting guide](../operations/troubleshooting.md).

## 5. Stop the stack

```bash
./scripts/agentic-soc-compose.sh down
```

The named PostgreSQL volume remains. Adding `--volumes` removes application state
and is destructive.

## Next steps

- [Complete first-run setup](first-run.md)
- [Create your first case](first-case.md)
- [Choose a source](../sources/support-matrix.md)
- [Harden the deployment](../operations/security.md)
