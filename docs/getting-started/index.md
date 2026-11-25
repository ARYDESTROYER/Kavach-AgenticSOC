---
title: Getting started
description: Choose the shortest supported path from a first look at Agentic SOC to a verified first case.
---

# Getting started

These guides apply to **Agentic SOC 0.2**. They take you from an empty checkout to a
working console, a configured source, and a case whose provenance you can verify.

## Choose a path

| Goal | Start here | What you need |
| --- | --- | --- |
| See the product without external services or model spend | [Run the demo](demo.md) | Python 3.11, Node.js 22, and npm |
| Evaluate the packaged stack | [Install Agentic SOC](install.md) | Docker Engine or Desktop and Docker Compose v2 |
| Configure an already-running deployment | [Complete first-run setup](first-run.md) | Console access and administrator permission |
| Prove data reaches the case workflow | [Create your first case](first-case.md) | One configured source and a synthetic test event |

The [Quickstart](quickstart.md) combines the demo and evaluation-stack paths in
one page. Use the individual guides when you want the prerequisites, validation,
and safety boundaries explained step by step.

## What success looks like

At the end of the onboarding path:

- the liveness and readiness checks pass;
- the Agentic SOC Console loads and setup is complete;
- at least one enabled source reports recent activity;
- a synthetic signal appears with the expected source, timestamp, rule, severity,
  and entity mapping;
- any model call appears in the cost ledger; and
- case actions appear in the audit trail.

!!! note "Evaluation boundary"

    Agentic SOC 0.2 is designed for a single backend replica. Some runtime-entered
    secrets and push-source evidence are memory-only. Keep the authoritative event
    in its source and read the [known limitations](../releases/known-limitations.md)
    before connecting sensitive or production data.

## Next steps

- [Understand the architecture](../concepts/architecture.md)
- [Connect a source](../sources/index.md)
- [Review source support](../sources/support-matrix.md)
- [Read the deployment guide](../operations/deployment.md)
