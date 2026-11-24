---
title: Create your first case
description: Send or select a synthetic signal and verify its path from source provenance to deterministic case action.
---

# Create your first case

This guide applies to **Agentic SOC 0.1**. It is for operators and analysts validating one
source end to end before broadening collection.

## Prerequisites

- setup is complete;
- one source is enabled;
- the source has a narrow alert or event feed; and
- you can create a harmless synthetic event with a unique entity and rule name.

## 1. Send or index a synthetic signal

For an HTTP webhook source named `edr-webhook`, post a small JSON event:

```bash
CHECK_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
curl --fail-with-body \
  -X POST http://localhost:8080/api/ingest/edr-webhook \
  -H 'Authorization: Bearer REPLACE_WITH_SOURCE_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-binary @- <<JSON
{
  "@timestamp":"${CHECK_TS}",
  "event":{"id":"tlsoc-docs-check-001","severity":75},
  "rule":{"id":"DOCS-CHECK","name":"Agentic SOC documentation check"},
  "source":{"ip":"192.0.2.10"},
  "host":{"name":"docs-check-host"},
  "message":"Synthetic Agentic SOC onboarding event"
}
JSON
```

Use an address reserved for documentation and testing. For a pull source, index an
equivalent record into the narrow test pattern and wait for the next poll, or invoke
the operator-approved manual poll action.

HTTP ingestion returns a non-success response if the complete batch cannot be
persisted. The sender should retry the same request; stable source-native IDs make
delivery retries safer.

## 2. Verify source receipt

Open **Sources**, locate the source, and check its latest event or poll state. Then
open its log view or **Unified logs** and confirm:

- source identity and connector provenance;
- the UTC timestamp;
- rule ID and name;
- severity;
- source address and host; and
- the original message.

If fields are missing or misplaced, correct the mapping before continuing. See
[Feeds and field mapping](../sources/feeds-mapping.md).

## 3. Inspect the case

Open **Case Manager** (or the established **Cases** table) and select the case for
the synthetic entity. Verify the separation
between:

- what the source reported;
- what deterministic correlation and risk logic computed;
- what the model assessed, if the candidate was admitted to investigation; and
- what deterministic policy decided.

In Case Manager, the Overview gives the AI's summary (tagged AI), and its **What
happened** section expands **Risk Assigned** into the stored score factors and ends at
**Decision**; Investigation carries the AI assessment plus the pinned deterministic
**Decision**, and its **Threat context** section the intelligence.

An event-feed candidate can remain visible without a model call when it does not
cross the investigation gate. That is expected and costs `$0`. An alert feed is
prioritized for investigation, subject to the global budget and safety controls.

## 4. Verify audit and cost

Open **Cost** after a model-backed investigation. The call must appear in the shared
ledger. Open **Audit** after acknowledging or changing the case; the action must be
recorded with the acting identity.

## Expected result

You can trace one synthetic source record through normalization, correlation, risk,
optional investigation, deterministic decision, case history, cost, and audit. Only
after this trace is correct should you widen the source pattern or event rate.

!!! note "Push evidence in 0.1"

    The push-source live-tail buffer is process-local and clears on restart. A case
    retains selected evidence references, but the original source or broker remains
    the authoritative event store.

## Next steps

- [How ingestion works](../architecture/ingestion.md)
- [Work with pull sources](../sources/pull.md)
- [Work with HTTP and syslog sources](../sources/http-syslog.md)
