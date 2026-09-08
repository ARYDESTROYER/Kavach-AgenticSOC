---
title: Run the demo
description: Explore Agentic SOC 0.1 with isolated synthetic data and a deterministic zero-cost model.
---

# Run the demo

This guide applies to **Agentic SOC 0.1** and is for evaluators who want to explore the
complete analyst workflow without external sources or model spend.

## Requirements

- Python 3.11
- Node.js 22 and npm
- macOS or Linux with Bash

No provider key is required. Demo Mode substitutes the deterministic `$0` provider
even when a real key is present.

## Start the demo

From the repository root:

```bash
./scripts/run-demo.sh
```

The script prepares the API and console, completes the demo setup, and enables an
isolated live simulation. Follow the address and demo-only credentials printed by
the script. Stop the processes with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

Set `DEMO_MODE=seeded` before running the script when you want a static dataset
instead of ongoing synthetic activity.

## What the demo exercises

The simulator creates protocol-compatible synthetic stories for Splunk HEC, QRadar
LEEF/offenses, Wazuh JSON, RFC syslog, and Microsoft Entra ID / Active Directory.
The Entra stream uses Microsoft Graph `auditLogs/signIns` and Identity
Protection-shaped vocabulary. All five pass through the real parser, OCSF
normalization, correlation, investigation, and deterministic decision pipeline.

Demo-generated cases, events, usage, retrieval data, and polling cursors are kept in
an isolated demo store. The mock model has zero price. The real deterministic case
policy is still used inside the sandbox: an uncertain verdict remains open for a
human.

## Suggested tour

1. Open **Overview** and inspect source coverage, the Human-vs-AI close
   attribution, and the Noise-Reduction flow.
2. Open **Case Manager**, compare the Overview, Timeline, Investigation, Threat,
   Collaboration, and Chat tabs, then try queue selection. The legacy **Cases**
   table remains available for comparison.
3. Open **Sources** and inspect the five simulated source types and recent activity.
4. Open **Detection & Rules**, Campaigns, Baseline, and Tuning to see the advisory
   automation loop.
5. Open **Cost** and confirm model spend remains `$0`.
6. Open **Audit** and trace the demo actions.

Use **Generate incident** in the Demo settings for an on-demand, cooldown-aware
five-source storyline. A successful request emits exactly eight native records:
four source-native alerts from Splunk, QRadar, Wazuh, and Entra plus four syslog
events that produce at least one Agentic SOC correlation detection. The response
attributes records, native alerts, and system detections per source.

## Exit safely

Use **Exit & clear** in the Demo settings. This stops the simulator and removes the
run-scoped synthetic state. Real tenant configuration remains separate; deliberate
organization-setting changes made during the demo are not automatically undone.

!!! warning "Demo credentials are not deployment credentials"

    Never reuse the demo account or its password for a real deployment. Enable
    authentication, create named users, and use unique secrets before connecting
    non-synthetic data.

## Next steps

- [Install the evaluation stack](install.md)
- [Complete first-run setup](first-run.md)
- [Understand deterministic decisions](../concepts/deterministic-decisions.md)
