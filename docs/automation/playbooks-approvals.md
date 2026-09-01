---
title: Playbooks and approvals
description: Run trusted procedures and keep consequential automation behind a human approval boundary.
---

# Playbooks and approvals

Playbooks are operator-authored Markdown procedures selected deterministically for a
case. They guide investigation; they do not override auto-close policy or directly
change case status.

Playbooks are different from [runbooks](../intelligence/runbooks.md). A runbook is
retrievable reference knowledge whose full body may ground an investigation; a
playbook is a separately selected procedure that an operator can explicitly run for a
case. Neither replaces deterministic case policy.

## Select and run a playbook

Open a case and choose **Run playbook**. Agentic SOC matches playbooks against rule IDs,
entity type, MITRE techniques, minimum event count, and tags; priority and version
make selection deterministic when multiple procedures match. Running one starts a
case-context re-investigation, so it can consume model budget.

Reading/opening the catalog requires `playbooks:read`; execution requires
`playbooks:run`. Creating, editing, or reloading operator files requires
`playbooks:manage` (built-in `super_admin` and `soc_manager`).

Before running:

1. confirm that the procedure applies to the case and environment;
2. review any outbound or destructive step as a human action outside the agent;
3. verify cost and model availability; and
4. record material results in the case timeline, thread, or tasks.

## Browse and manage procedures

Open **Intelligence → Response playbooks**. Every card identifies its ownership:

- **Bundled** procedures ship with Agentic SOC. You can open and copy their plain Markdown,
  but they are protected from runtime edits so an upgrade has a stable reference set.
- **Operator** procedures live in the configured playbook directory. A principal with
  `playbooks:manage` can open **New playbook**, create a slug-bound Markdown file, and
  edit it later from **Open source → Edit**.

The editor stores plain UTF-8 Markdown; it does not render operator text as HTML. IDs
must be lowercase slugs (`a-z`, `0-9`, `_`, `-`, maximum 64 characters), and the
front-matter `id` must match the selected ID. The backend bounds documents to 256 KiB,
rejects traversal and symbolic-link targets, writes through an atomic replacement, and
reloads the registry only after the candidate validates. A failed replacement restores
the prior operator file. The client never receives a server filesystem path.

Create/update/reload operations append a `playbook` event to the durable audit log.
Deleting files is intentionally not exposed in v0.1; retire a procedure by removing it
through controlled deployment/configuration management and reloading the registry.

If Playbooks is disabled in Settings, the catalog remains manageable but procedures are
not injected into investigations. This is useful for preparing a change before enabling
it. Changing a playbook affects future selection or explicit re-investigation only; it
does not rewrite historical case decisions.

The installed catalog contains nine protected procedures for credential attacks,
cloud-identity compromise, data exfiltration, reported phishing, privileged web
access, ransomware impact, suspicious outbound traffic, web application abuse, and
web scanner/exploit activity. Selection uses exact declared rule IDs; an unrelated rule
does not receive a procedure merely because its text sounds similar. Use **Dry run**
and **Coverage** before adding operator procedures, and prefer filling a demonstrated
unmatched family over duplicating an existing playbook with broader matching.

## Case automation and proposals

A case-automation rule may request approval instead of performing a consequential
action. Confirmed false positives can also draft a suppression proposal. These
proposals begin pending and do nothing until an authorized administrator approves
them.

Open **Triage → Approvals** to review:

- the proposed operation and payload;
- source case and evidence;
- confidence and rationale;
- expiry or scope; and
- audit history.

Approval and rejection are privileged administrative actions. Approval applies only
the allow-listed proposal type; it does not grant the model a general write channel.

## Safety model

Agent tools are assigned safety tiers. v0.1 investigation tools are read-only. A
future managed or outward action must remain audited and, where consequential,
approval-gated. Closing a case or approving a proposal is never an autonomous tool
action.

See [Detection and rules](rules.md), [Cases](../analyst/cases.md), and
[Runbooks](../intelligence/runbooks.md).
