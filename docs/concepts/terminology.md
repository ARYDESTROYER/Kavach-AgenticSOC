---
title: Terminology
description: Use the stable Agentic SOC 0.1 names for the product, technical compatibility namespace, telemetry, cases, and releases.
---

# Terminology

This glossary applies to **Agentic SOC 0.1**. Use these names in source configuration,
operator procedures, API integrations, and support requests.

## Product and release names

| Term | Meaning |
| --- | --- |
| **Agentic SOC** | Full and preferred operator-facing product name |
| **Console** | Standalone Agentic SOC web interface |
| **Agentic SOC API** | Backend application and `/api` surface |
| **TLSOC** | Compatibility namespace retained in technical identifiers; not the operator-facing product name |
| **Testing** | Integration branch and pre-stable validation channel |
| **Stable** | Supported release channel built from the `main` branch |
| **0.1** | Documentation and human-facing release line |
| **0.1.13** | Current SemVer artifact version; immutable tag `v0.1.13` only after verified Stable promotion and complete signed/public artifact publication |
| **0.1.12** | Immutable complete signed-publication record; canonical v0.1.1 bootstrap failed closed before application mutation because matching absent legacy schema labels were normalized asymmetrically |
| **0.1.11** | Immutable failed-publication record; images and plan verified, including inside the constrained updater, but post-verification cleanup failed before the canonical Release and assets existed |
| **0.1.10** | Immutable failed-publication record; superseded and non-installable because its signed-release job stopped before a complete public release existed |

Do not use “Bleeding Edge,” `next`, or “alpha” for the active 0.1 release model.

### Technical namespace compatibility

The rename does not alter wire or deployment contracts. Keep existing identifiers
such as `TLSOC_*` environment variables, `tlsoc-*` containers and images,
`tlsoc-agent-*` indices, `tlsoc_*` cookies/storage keys, `X-TLSOC-*` headers,
`tlsoc.connectors` entry points, Python import paths, and existing API fields exactly
as documented. A copy-only change must never rename one of those values. In prose,
say **Agentic SOC**, **Console**, or **Agentic SOC API** as appropriate.

## Security data lifecycle

| Term | Definition |
| --- | --- |
| **Source** | One configured connector instance, such as a particular Wazuh indexer or webhook sender |
| **Feed** | A source-specific stream or index pattern with an `events`, `alerts`, or `ignore` role |
| **Event** | A source record normalized to the Agentic SOC OCSF subset |
| **Detection** | A source-provided or Agentic SOC-produced finding that identifies suspicious activity |
| **Alert** | A source-native detection feed whose signals are prioritized for investigation |
| **Candidate** | A correlated record visible in Agentic SOC but not necessarily admitted to model investigation |
| **Case** | The human-reviewable unit containing provenance, evidence, assessment, decision, status, and collaboration |
| **Campaign** | An advisory grouping that references related case IDs; it does not merge or close cases |

Keep these records distinct. A source alert is not silently relabeled as an Agentic SOC
detection, and a campaign never rewrites a member case's history.

## Case terms

- **Verdict** is the model assessment: true positive, false positive, or needs
  human review.
- **Decision** is the deterministic policy result that closes, escalates, or routes
  a case to a human.
- **Status** is lifecycle state, such as new, investigating, escalated, on hold,
  resolved, needs human, or closed.
- **Disposition** is the analyst's classification, such as true positive, false
  positive, benign, suspicious, duplicate, or undetermined.
- **Risk** is a deterministic score used for prioritization and investigation
  routing. It is not the model's confidence.
- **Confidence** is the model's confidence in its verdict. It never acts alone.

### Verdict values

The API, audit records, and exports spell verdicts as these exact tokens:

| Value | Console label | Meaning |
| --- | --- | --- |
| `TRUE_POSITIVE` | True positive | The model assessed the activity as a real, actionable threat. The case routes to an analyst and, above the escalation thresholds, is flagged for priority attention. Automatic closure of true positives is an explicit opt-in that is off by default. |
| `FALSE_POSITIVE` | False positive | The model assessed the activity as benign or noise. The deterministic auto-close policy may close the case when the confidence and risk thresholds allow it. |
| `NEEDS_HUMAN` | Needs human | The model could not reach a safe verdict, or an error, budget block, or policy routed the case to an analyst. A `NEEDS_HUMAN` verdict never closes automatically. |

`needs_human` is also a retained lifecycle **status** that the Console shows as
"open · awaiting analyst". A verdict is a recommendation; the decision that follows it
is made by deterministic code, as described in
[Deterministic decisions](deterministic-decisions.md).

### Decision owners

The `decision_by` field records who made a case's latest decision:

| Value | Meaning |
| --- | --- |
| `agent` | The deterministic auto-close policy closed the case after the model's verdict |
| `analyst` | A human analyst acted on the case |
| `system` | Deterministic routing, such as a fail-to-human route after an error or budget block |
| `analyst_policy` | An operator "declared benign" rule policy closed the case without a model call; excluded from agent performance metrics |

For how these values feed the dashboard, see the [KPI glossary](../analyst/kpi-glossary.md).

## Automation terms

- **Autopilot** is the bundle of default-enabled deterministic and bounded
  behaviors, including comprehensive ingestion, risk admission, tuning, campaigns,
  cross-source correlation, baselines, SLA policy, and coverage signals.
- **Detection rule** describes source matching, thresholding, or anomaly logic.
- **Case-automation rule** can tag, recommend, notify, request approval, or queue
  an allowed playbook action after a decision. It cannot bypass case policy.
- **Playbook** is trusted operator-authored investigation context. It recommends;
  it does not decide.

## Source and state terms

- **Log source** is the external system of record for telemetry.
- **State backend** is Agentic SOC's own bookkeeping store. Changing it does not move or
  select the log source.
- **Primary source** is the enabled pull source used for the primary ad-hoc query
  surface. A push receiver cannot be primary.
- **Secret tier** is the non-persisted runtime store for source and integration
  secret values. Persisted source configuration contains only configured field names.

## Related pages

- [Architecture](architecture.md)
- [Feeds and field mapping](../sources/feeds-mapping.md)
- [Deterministic decisions](deterministic-decisions.md)
- [Versioning](../releases/channels.md)
