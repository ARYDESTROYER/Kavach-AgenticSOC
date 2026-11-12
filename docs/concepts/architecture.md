---
title: Architecture
description: Follow an Agentic SOC 0.1 signal from an external source to a human-reviewable case.
---

# Architecture

This page applies to **Agentic SOC 0.1**. It is for evaluators, operators, and integrators
who need the shipped system boundary before configuring data or automation.

Agentic SOC is a read-only security-triage layer. It receives or reads security events,
normalizes them to OCSF, performs deterministic reduction and risk work, admits a
bounded subset to model-backed investigation, and stores an auditable case. It does
not replace or modify the upstream SIEM, EDR, queue, or event pipeline.

## Components

| Component | Responsibility |
| --- | --- |
| Agentic SOC Console | Standalone React interface for setup, sources, cases, analytics, administration, and audit |
| Agentic SOC API | FastAPI application containing connectors, normalization, engines, agents, policy, auth, and API routes |
| Connector registry | Pull connectors and push receivers that expose one manifest and normalization contract |
| OCSF boundary | Canonical event subset plus lossless source provenance and unmapped fields |
| Deterministic engines | Correlation, risk, budget admission, baselines, tuning, campaigns, and case policy |
| LLM gateway | The only path to a model provider and the usage/cost ledger |
| StateStore | Agentic SOC-owned cases, configuration, cursor, usage, audit, users, and knowledge in PostgreSQL, SQLite, or Elasticsearch |
| Background-job runner | In-process executor over a strict-CAS StateStore registry, with leases, Inbox/SSE progress, cooperative cancellation, and verified artifacts |

## Shipped signal flow

The diagram follows one security signal through 11 numbered stages, set in three bands.
The top band is the deterministic data plane: every enabled event, with no model call.
The middle band is admission and reasoning: only admitted candidates reach a model. The
bottom band decides, records, and presents the case. The state store runs along the
bottom. Each dashed orange outline marks untrusted data that comes from a source.
Select a diagram to open it full size.

<figure markdown="span">
[![Agentic SOC architecture: security sources inside an untrusted-data fence flow through connectors, OCSF normalisation, durable-cursor ingest, deterministic correlation and risk scoring, and admission gates. Admitted candidates go to an advisory AI investigation with read-only tools; all model calls go through one gateway and cost ledger. The deterministic Case Manager decides close, escalate or needs human, and the result is recorded with an append-only audit log, shown in the Console and API with Workspace Chat, and stored in PostgreSQL with pgvector, Elasticsearch or SQLite.](../assets/architecture/system-light.svg#only-light) ](../assets/architecture/system-light.svg)
[![Agentic SOC architecture: security sources inside an untrusted-data fence flow through connectors, OCSF normalisation, durable-cursor ingest, deterministic correlation and risk scoring, and admission gates. Admitted candidates go to an advisory AI investigation with read-only tools; all model calls go through one gateway and cost ledger. The deterministic Case Manager decides close, escalate or needs human, and the result is recorded with an append-only audit log, shown in the Console and API with Workspace Chat, and stored in PostgreSQL with pgvector, Elasticsearch or SQLite.](../assets/architecture/system-dark.svg#only-dark) ](../assets/architecture/system-dark.svg)
<figcaption>Agentic SOC architecture and data flow. Code decides; the model only recommends.</figcaption>
</figure>

Pull connectors are polled per enabled source and feed. Push receivers deliver
normalized batches into the same correlation and case pipeline. Source identity is
retained throughout, so the console can distinguish what the source reported, what
the model assessed, and what code decided.

Long operations that the Console accepts, such as exports and bulk case work, run as
background jobs: a strict-CAS job record with a renewable lease, checkpointed work, an
audit record, and a result the Console shows. See
[Background jobs](../operations/background-jobs.md).

### Stage by stage

1. **Connectors.** Agentic SOC reads security sources through 3 pull connectors
   (Elasticsearch, OpenSearch, and the Wazuh indexer) with a read-only, scoped key, and
   receives them through 16 push, queue, and object-store receivers, from webhook,
   Splunk HEC, and syslog to Kafka, cloud queues, and object stores.
2. **Normalise to OCSF.** Every record becomes a canonical OCSF 1.4 event that keeps its
   source provenance. The `unmapped` and `raw_data` fields are kept, but they are always
   treated as untrusted and fenced.
3. **Poll and ingest.** Pull sources are read on a durable cursor per source and feed,
   so nothing is skipped or duplicated. Push and queue batches join the same pipeline.
4. **Correlate and score.** Deterministic code groups events into entity clusters. A
   case signature keeps cases idempotent, so a repeat updates the existing case instead
   of creating a copy. Each cluster gets a risk score from 0 to 100. Stages 1 to 4 never
   call a model.
5. **Admission gates.** The routing risk gate sends event clusters on at risk 70 or more
   by default. Alert feeds go straight on. Anything below the floor stays a visible `$0`
   candidate and is never dropped. The budget gate then checks the pipeline's daily AI
   budget and caps before any model call; an over-budget case goes to a person.
6. **AI investigation.** This stage is model-backed and advisory. The router does a
   cheap first triage. The investigator runs a ReAct loop over read-only tools: log
   queries with the read-only key, cached enrichment, knowledge retrieval, Published
   runbooks, and MITRE ATT&CK context. The formatter returns a verdict, a confidence,
   and compact evidence as a recommendation only. Source-derived evidence enters every
   prompt fenced and labelled as untrusted data.
7. **One model gateway.** Every model call, from investigation and from chat, goes
   through one gateway to the configured provider (Anthropic, OpenAI, Azure OpenAI,
   Bedrock, Vertex, or an OpenAI-compatible endpoint). The gateway runs the pipeline
   budget pre-flight, retries, and a circuit breaker, and writes one usage and cost
   record for every call. Workspace and Case Manager chat are metered there too but sit
   outside the daily and monthly AI budget.
8. **Case Manager.** Deterministic code, `decide()`, compares the verdict, confidence,
   and risk with your `AutoClosePolicy` and chooses close, escalate, or needs human. The
   model only recommends, a runbook cannot change the policy, and needs human never
   auto-closes.
9. **Cases and audit.** Cases are idempotent by signature and carry notes, tasks, and
   runbook runs. Every agent and human action is written to the append-only audit log.
10. **Console and API.** Analysts use the React Console through the FastAPI API, with
    sign-in, roles, and permissions, to review, approve, and close cases, and receive
    notifications and in-app Inbox items. Workspace Chat is the one chat engine and uses
    only read-only tools; untrusted values stay fenced there too.
11. **State store.** The application keeps its own records apart from your source logs:
    cases, audit log, usage ledger, cursors, configuration, users, knowledge, and
    runbooks. Choose one backend: PostgreSQL with pgvector (the reference Compose stack),
    Elasticsearch (an existing ELK stack), or SQLite (a single node, for evaluation).

## Reference deployment

The reference Compose file, `deploy/docker-compose.agnostic.yml`, runs this system as
five containers on one Docker host. Only ports `8080` (the Console) and `8088` (the API)
are published.

<figure markdown="span">
[![Agentic SOC reference Compose deployment on one Docker host: a browser reaches tlsoc-webui (nginx) on published port 8080, which proxies /api to tlsoc-backend on port 8088 (also published for API clients and push senders). The backend uses tlsoc-postgres with the tlsoc-pgdata volume and tlsoc-redis, neither published, and connects out read-only to security sources, model providers and enrichment. The agentic-soc-updater supervisor alone mounts the Docker socket, talks to the backend over a private control.sock volume, and fetches signed releases only for an approved update.](../assets/architecture/deployment-light.svg#only-light) ](../assets/architecture/deployment-light.svg)
[![Agentic SOC reference Compose deployment on one Docker host: a browser reaches tlsoc-webui (nginx) on published port 8080, which proxies /api to tlsoc-backend on port 8088 (also published for API clients and push senders). The backend uses tlsoc-postgres with the tlsoc-pgdata volume and tlsoc-redis, neither published, and connects out read-only to security sources, model providers and enrichment. The agentic-soc-updater supervisor alone mounts the Docker socket, talks to the backend over a private control.sock volume, and fetches signed releases only for an approved update.](../assets/architecture/deployment-dark.svg#only-dark) ](../assets/architecture/deployment-dark.svg)
<figcaption>The reference Compose deployment on one Docker host.</figcaption>
</figure>

- `tlsoc-webui` (nginx) serves the Console and the `/docs` Help Center and proxies
  `/api/`, the event stream, and the chat stream to the backend.
- `tlsoc-backend` runs the API, connectors, receivers, engines, and agents. HTTP push
  senders post to `/api/ingest/<source-id>` on port `8088`; other receiver ports bind
  inside the container and are published only when you configure them.
- `tlsoc-postgres` holds all application state on the named volume `tlsoc-pgdata`, and
  `tlsoc-redis` is a cache without persistence. Neither is published.
- `agentic-soc-updater` is the private update supervisor. It is the only service that
  mounts the Docker socket, it talks to the backend only through a private control
  socket, and it fetches signed, digest-pinned releases only when an administrator
  approves an update.

See [Install Agentic SOC](../getting-started/install.md) to start it and
[Deployment](../operations/deployment.md) for the other topologies.

## Two data planes

The economical design separates two kinds of work:

1. The **deterministic data plane** parses, maps, deduplicates, correlates, scores,
   counts, and learns bounded aggregate baselines without a model call.
2. The **bounded reasoning plane** enriches and investigates candidates admitted by
   source role, deterministic risk, operator policy, caps, and budget.

This means “Agentic SOC reads every enabled event” does not mean “every event is sent to a
model.” Below-threshold event candidates remain visible and cost nothing.

## Trust boundaries

- Pull connectors use read-only, pattern-scoped source credentials.
- Push receivers authenticate the sender at their transport boundary.
- Event-derived text remains untrusted, including raw and unmapped OCSF fields.
- Model output is advisory; deterministic policy owns close or escalation.
- Agentic SOC application state is separate from the source log store.
- Every model call and state-changing action has a ledger or audit record.

## Agentic SOC 0.1 boundaries

The API, receivers, polling, schedules, correlation, and investigation run in one
backend process. Operate one backend replica. HTTP push processing has no durable
receipt inbox before correlation, and the push live-tail and realtime replay buffers
are process-local. Several connectors require transport-specific durability testing.

These are explicit evaluation constraints, not properties of the target scale-out
design. See [Known limitations](../releases/known-limitations.md).

Application background jobs make accepted long work durable across Console navigation,
reload, and ordinary backend restart recovery. They do not create a distributed worker
plane: job execution, investigation priority, export assembly, and realtime publication
are process-local, and the wider application still has single-replica authorities. The
separate supervised-updater job protocol is unchanged. See
[Background jobs](../operations/background-jobs.md).

## Related pages

- [Ingestion and investigation](../architecture/ingestion.md)
- [OCSF normalization](ocsf.md)
- [Deterministic decisions](deterministic-decisions.md)
- [State, audit, and cost](state-audit-cost.md)
- [Background jobs](../operations/background-jobs.md)
