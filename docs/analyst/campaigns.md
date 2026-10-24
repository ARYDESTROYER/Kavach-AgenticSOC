---
title: Campaigns
description: Review advisory cross-case groupings without merging case identity or decisions.
---

# Campaigns

A campaign groups related cases by shared entities and overlapping MITRE ATT&CK
techniques. It is an analyst aid for recognizing a wider incident; it does not merge
case records, change their signatures, or close them.

Open **Triage → Campaigns**. Reading campaigns requires `cases:read` when RBAC is
enabled.

## What a campaign contains

- a stable campaign ID and generated name;
- member cases, each named by its case number as elsewhere in the console (the internal
  case ID is in its tooltip; a case without a number shows its ID), listed in case-number
  order with any case without a number last;
- shared entities and ATT&CK techniques;
- first- and last-seen time;
- severity rollup; and
- open, monitoring, or resolved status.

Each member case remains independently assignable, explainable, and auditable. Open
a member to inspect its own source, evidence, risk, verdict, and decision.

## Use campaigns safely

1. Confirm the shared entity is meaningful. A public address or common domain can be
   a weak relationship.
2. Compare time overlap and ATT&CK context.
3. Assign or tag the member cases rather than treating the campaign as a replacement
   case.
4. Record the analyst's incident-level interpretation in the relevant case or
   external incident process.

Campaign correlation is deterministic and advisory. The v0.1 scheduler and lifecycle
have documented limits; read [Known limitations](../releases/known-limitations.md)
before treating campaigns as an authoritative incident ledger.

## Configuration and refresh

Campaign clustering is enabled by default with a daily configured cadence. An admin
can change the configuration or request re-correlation. These operations rebuild the
current advisory grouping; they do not rewrite the history or decisions of member
cases.

Continue with [Cases](cases.md) and
[MITRE and threat context](../intelligence/mitre-threat-context.md).
