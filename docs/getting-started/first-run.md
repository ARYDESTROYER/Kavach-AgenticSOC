---
title: First-run setup
description: Choose a workspace, connect data sources and an AI runtime, and launch Agentic SOC with an honest readiness review.
---

# First-run setup

This guide applies to **Agentic SOC 0.1** and is for administrators opening a new Agentic SOC
Console for the first time. The console shows setup instead of the operational
workspace until the deployment is marked complete.

## Before you begin

For a fully operational **Live environment**, have the following ready:

- a unique administrator password;
- one source and a synthetic event you can safely send;
- a read-only source credential for a pull connector, or an authentication secret
  for a push receiver; and
- an OpenAI provider key for the default GPT-5.6 Luna runtime, or another supported
  provider key if you plan to change the role assignments.

You may also launch a live workspace without a source or provider. The review stage
labels that state **Ready with limited capabilities** and explains exactly what will
not work until those items are added. For an evaluation with no live credentials,
choose **Synthetic demo** instead.

## 1. Secure the administrator account

When authentication is enabled and no user exists, Agentic SOC can bootstrap an initial
administrator. If the deployment presents the seeded `Admin` account, replace its
default password immediately and create named accounts before connecting real data.
Never retain demo credentials on a shared deployment.

For role design, MFA, SSO, and session policy, see
[Identity and access](../administration/users-rbac.md).

## 2. Workspace

Choose one starting mode:

- **Live environment** connects your own security systems and AI provider. Polling
  and processing begin after setup is launched.
- **Synthetic demo** seeds isolated sample cases, metrics, and activity and uses the
  deterministic `$0` mock runtime. It never calls a configured live provider and is
  not a connection test for a real source.

Demo data and the mock runtime make the next two stages optional. Demo Mode is
reversible and can be removed later.

## 3. Data sources

The source editor is driven by connector manifests. It renders the connection,
authentication, feed, and mapping fields supported by the selected connector.

1. Choose an implemented connector from the [support matrix](../sources/support-matrix.md).
2. Give the source a stable ID and a recognizable display name.
3. Configure the transport and non-secret fields.
4. For a pull source, use a credential restricted to read and index-metadata access
   on the intended patterns. Never use a superuser or service-system account.
5. Configure one narrow feed first.
6. Use **Test connection** for Elasticsearch, OpenSearch, or Wazuh. The test uses
   the current draft without saving it.
7. Save a push receiver, send a synthetic event, and inspect source health instead;
   push and broker receivers do not have a meaningful one-shot connection test.

Secret values are not returned to the console. The source record stores only which
secret field names are configured. If the source editor is open and you try to move
to another setup stage or close a re-run, Agentic SOC asks before discarding that
draft.

## 4. AI runtime

Add an OpenAI key for the fresh-install GPT-5.6 Luna completion defaults, or add an
alternate provider key and change the role assignments in Settings. Provider keys are
**write-only**: the console reports only whether one is configured and never returns
its value. A blank field leaves an existing key unchanged. A newly typed key saves
automatically when you leave this stage, including Back, a progress-stage link,
Continue, or a setup re-run's Close action. If the write fails, setup stays on the
AI runtime stage so you can retry.

Fresh workspaces assign `gpt-5.6-luna` to router, investigator, formatter, standup,
chat, and overview; embeddings remain on `text-embedding-3-small`. Existing stored
assignments are never rewritten. Provider/model selection, self-hosted
OpenAI-compatible endpoints, budgets, and per-role routing remain configurable under
**Settings → General → Models** after launch. In Demo Mode, the deterministic mock runtime is
already available, so a live key is optional.

Every provider call passes through the shared cost ledger. The default daily budget
is a preflight ceiling, not a provider-side billing limit; configure provider-side
budgets as a second boundary.

## 5. Review & launch

The final stage reports each item as **Ready**, **Needs attention**, or **Optional**.
It distinguishes these outcomes instead of claiming every configuration is complete:

- **Demo workspace is ready** when Synthetic demo is active;
- **Ready for live triage** when a live source and provider are configured; or
- **Ready with limited capabilities** when live telemetry or a live provider is
  missing.

The **Automation posture** row explains that adaptive investigation routing and
related-case grouping are on by default. Detailed controls remain in **Settings**.
This posture does not change the deterministic close/escalate authority.

Select **Launch Agentic SOC** on first run. This calls `POST /api/setup/complete`,
starts enabled pull polling, and reconciles enabled background receivers. If a
completion response is lost, the console checks the authoritative setup status
before showing a failure so a successful launch does not strand you in setup.

Administrators can re-run the same workflow from **Settings**. The final action is
then **Apply changes**, and **Close** returns without marking setup incomplete.
Existing sources and credentials remain in place unless you explicitly change or
remove them.

If `GET /api/setup/status` cannot be read, the console fails closed: it shows
**Can't verify setup state** with **Retry** instead of opening an operational page
whose setup state is unknown.

## Verify setup

After the workspace opens:

- **Sources** lists the new source and its enabled state;
- source coverage or health shows a successful poll or recent event;
- **Unified logs** shows the expected normalized fields;
- **Cost** is zero until a model-backed action runs; and
- **Audit** records later state-changing actions.

!!! warning "Do not widen scope yet"

    Validate timestamp, native ID, rule, severity, user, host, address, and source
    provenance with synthetic data before adding broad event patterns. Mapping
    mistakes at this stage can create misleading correlations and cases.

## Next steps

- [Create your first case](first-case.md)
- [Understand feeds and mapping](../sources/feeds-mapping.md)
- [Understand deterministic decisions](../concepts/deterministic-decisions.md)
