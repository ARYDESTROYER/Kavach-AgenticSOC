---
title: Runbooks
description: Create compact investigation guidance without changing case policy.
---

# Runbooks

Open **Intelligence → Reference runbooks** to browse the investigation guidance available to
knowledge retrieval. A Runbook combines a small machine-readable manifest with a
strict plain-text guidance body. It is a trusted reference for analysts and the
investigator, not an executable response workflow. A Runbook cannot close, escalate,
suppress, or otherwise change a case.

Use a Runbook for reusable investigation knowledge such as:

- how to recognize an alert pattern;
- which evidence to collect and pivots to run;
- local environment context that applies to a detection family; and
- evidence that supports each possible verdict.

Use a [playbook](../automation/playbooks-approvals.md) when you need a procedure that
is selected for a case and explicitly run. Use [operator memory](knowledge-memory.md)
for one short durable fact rather than structured investigation guidance.

## Why the body limit is 1,800 characters

New and edited operator Runbooks have a maximum **1,800-character guidance body**.
The manifest is not part of this body budget. The Console counts Unicode characters
after front-matter parsing, newline normalization, and outer-whitespace trimming.
Section labels, internal spaces, and line breaks count toward the limit.

The limit intentionally keeps one Runbook within one bounded retrieval chunk and is
roughly 400–500 tokens for typical English security guidance. Token counts vary by
provider and content, so the character limit is the enforced, provider-neutral rule.
The retrieval projection also prefixes a concise manifest descriptor. That descriptor
has its own **1,200-character aggregate maximum** across the title, summary,
applicability values, keywords, and optional persona; the token estimate above applies
to the guidance body, not that separately bounded descriptor.

A 425-character maximum would normally be only about 90–120 tokens. That is too short
to identify the signal, name required evidence, provide ordered investigation steps,
distinguish true and false positives, define the human-review boundary, and recommend
a next action without becoming vague. The 1,800-character ceiling is still small
enough to control retrieval context and inference cost while preserving useful,
reviewable guidance.

## Browse, ownership, and compatibility

The Runbooks workspace searches titles, summaries, rules, ATT&CK techniques,
entities, and keywords. Each row identifies its ownership and retrieval state:

- **Bundled** Runbooks ship with the installed release. They are readable but
  protected from editing and deletion.
- **Operator** Runbooks are stored in the selected Agentic SOC state backend. They
  can be created, updated, and deleted by a principal with `runbooks:manage`.
- **Ready** means the latest saved revision is available to retrieval. **Pending**,
  **Stale**, or **Failed** means the saved document and retrieval projection are not
  in sync; open the item for the exact status and recovery action.

Reading the catalog and full content requires `runbooks:read`. The Console hides
management actions without `runbooks:manage`, and the API enforces the same boundary.

The installed catalog includes nine protected references spanning authentication
abuse, cloud IAM compromise, data exfiltration, IOC reputation, mail abuse,
malware/C2, reconnaissance, vulnerability scanning, and web exploitation. These are
portable starting points, not claims that every environment emits the required
telemetry. Operators should add a local Runbook only when its exact detection IDs,
evidence fields, ownership context, and benign lookalikes are reviewed.

The stricter authoring standard does not hide or invalidate older stored Runbooks.
Legacy and bundled content remains readable and reindexable. When an operator edits a
legacy Runbook, the replacement must satisfy the current manifest, body structure,
formatting, and length rules before it can be saved. This preserves retrieval during
the migration while preventing new non-compliant revisions.

## Add a Runbook

Select **New Runbook**. The Add and Edit views contain the complete authoring standard,
live body-character accounting, and immediate validation. The API performs the same
validation and remains authoritative if a different client submits content.

The Add view also includes a small **Example Runbooks** library. Each example is a
complete `.md` file that passes the current strict authoring policy. Preview the
signal family and download the closest example, then replace its synthetic IDs,
applicability metadata, evidence requirements, benign lookalikes, and escalation
boundary with values reviewed for your environment. Downloading an example does not
create, save, index, or execute a Runbook, and examples contain no production data.
They are starting points rather than evidence that a detection is covered.

Start with this complete template:

```text
---
id: suspicious_powershell
title: Suspicious PowerShell execution
summary: Triage encoded or policy-bypassing PowerShell on a managed endpoint.
persona: malware
applies_to_rules: [powershell, sysmon]
applies_to_techniques: [T1059.001]
applies_to_entities: [host, user]
keywords: [powershell, encodedcommand, scriptblock]
---

SIGNAL
Encoded or policy-bypassing PowerShell was observed on a managed endpoint.

EVIDENCE REQUIRED
Collect process lineage, command line, script-block telemetry, and user context.
Collect related process and network activity for the same time window.

INVESTIGATION STEPS
1. Confirm the parent process, user, host, and execution time.
2. Recover and inspect the script content without executing it.
3. Pivot across related processes, destinations, and affected identities.

TRUE POSITIVE SIGNALS
Unexpected encoded content or suspicious lineage supports a true positive.
Corroborating persistence or network activity increases confidence.

FALSE POSITIVE SIGNALS
An approved administrative script with matching change evidence supports a false positive.
Confirm that there is no suspicious follow-on activity.

NEEDS HUMAN WHEN
Required telemetry is missing or evidence conflicts.
Ownership or authorization cannot be verified.

RECOMMENDED NEXT ACTION
Preserve the evidence and escalate for containment when malicious execution is confirmed.

LIMITATIONS
Script-block logging may be unavailable on older or unmanaged endpoints.
```

`LIMITATIONS` is optional. Omit both its label and content when there is no material
limitation to disclose.

### Manifest requirements

The front matter is deliberately small and is separate from the plain-text body:

- `id` is required. It is a stable lowercase slug using letters, digits, `_`, or
  `-`, with a maximum of 64 characters. It must match the Runbook being created or
  edited. `readme`, `index`, and `reindex` are reserved.
- `title` is required and names the guidance for operators.
- `summary` is required. Use one concise sentence describing the signal and
  investigation objective.
- `applies_to_rules` is required and must contain at least one exact detection-rule
  identifier.
- `applies_to_entities` is required and must contain at least one relevant entity,
  such as `host`, `user`, or `ip`.
- `keywords` is required and must contain at least one precise alert term, product,
  behavior, or observable that improves retrieval.
- `applies_to_techniques` is optional. Values must look like `T1234` or
  `T1234.001`.
- `persona` is optional and identifies a useful specialist perspective.

These are the only supported manifest fields. An unknown field is rejected rather
than silently becoming unused context. Use only scalar values and inline or indented
lists in front matter. Do not add nested objects, aliases, multiline YAML values, or
decorative metadata. Keep the ID stable after publication so citations and retrieval
provenance remain attributable.

Strict write ceilings are: title 120 characters, summary 280 characters, persona 48
characters, and each list at most 12 items with at most 64 characters per item. The
combined retrieval descriptor may not exceed 1,200 Unicode characters even when every
individual field is within its own limit. The complete UTF-8 document also has a
128 KiB parser safety ceiling. These outer bounds are not targets: include only
metadata that materially improves retrieval, and treat the 1,800-character body as
the complete instruction budget.

Manifest values follow the same plain-text principle as the body. Headings, table
pipes, bold, italics, underline, strikethrough, backticks, Markdown links or images,
autolinks, raw HTML, and template placeholders are rejected. Ordinary underscores in
identifiers and an unformatted plain URL remain valid.

### Required body structure

The body must contain these exact labels, each alone on its own line and in this
order:

1. `SIGNAL`
2. `EVIDENCE REQUIRED`
3. `INVESTIGATION STEPS`
4. `TRUE POSITIVE SIGNALS`
5. `FALSE POSITIVE SIGNALS`
6. `NEEDS HUMAN WHEN`
7. `RECOMMENDED NEXT ACTION`

Every required section must contain at least 12 non-whitespace characters before the
next label. Empty and token-only sections are rejected. `LIMITATIONS` may appear once
after `RECOMMENDED NEXT ACTION` and must meet the same minimum when present.

Only `INVESTIGATION STEPS` may use numbered lines. Number every step sequentially as
`1.`, `2.`, `3.`, and so on. Keep one action on each numbered physical line; do not
wrap a step onto an unnumbered continuation line. All other sections use short plain
sentences, one point per line where practical.

### Formatting that is rejected

The guidance body is deliberately plain text. Submissions are rejected when they
contain:

- ATX or setext Markdown headings, such as `# Signal` or a title underlined with
  `===`;
- GFM tables or table-divider syntax;
- bold, italic, strikethrough, or underline markup;
- inline code spans, fenced code blocks, or indented code blocks;
- unordered Markdown bullets beginning with `-`, `*`, or `+`;
- task lists, blockquotes, or horizontal rules;
- Markdown links, images, or angle-bracket autolinks;
- raw HTML, including `<u>` tags;
- obvious unfilled template placeholders; or
- numbered steps outside `INVESTIGATION STEPS`, or missing, repeated, or
  non-sequential step numbers inside that section.

Do not add formatting merely to improve the Console preview. The model consumes the
retrieved text, not its visual presentation. The fixed labels preserve consistent
structure without spending tokens on author-selected Markdown decoration.
Ordinary underscores in identifiers such as `rule_name` and an unformatted plain URL
are accepted, although references should be omitted when they do not improve the
investigation.

### Content quality requirements

Keep each statement operational and evidence-based:

- Name the exact telemetry, field, entity, time window, or corroborating source an
  analyst should inspect.
- Distinguish observation, inference, and recommendation. Do not present an
  inference as a recorded fact.
- State concrete benign lookalikes and the evidence needed to confirm them.
- Make uncertainty explicit. Missing, conflicting, or insufficient evidence belongs
  in `NEEDS HUMAN WHEN`.
- Keep investigation steps read-only. A Runbook may recommend a controlled action,
  but it must not claim to execute that action.
- Prefer exact rule IDs, ATT&CK IDs, entity kinds, and established analyst terms over
  broad synonyms or repeated prose.
- Do not repeat the title, summary, keyword list, or applicability manifest in the
  body unless the repetition is necessary to make an instruction unambiguous.
- Never include credentials, tokens, secrets, raw personal data, complete production
  logs, or unreviewed instructions copied from telemetry.
- Remove all template prompts and replace them with reviewed, deployment-appropriate
  guidance before submission. Use a reserved synthetic value only when an example is
  essential.

## Understand and fix a rejection

An invalid submission is not saved and is not indexed. The Add and Edit views report
all detected problems together. Each issue includes a stable code and field plus
three operator-facing parts:

- **Missing or invalid:** the exact field, section, character limit, or formatting
  rule that failed.
- **Why rejected:** the retrieval, token-budget, safety, or structural reason for the
  rule.
- **How to fix:** a concrete correction, including the required label or replacement
  form where applicable.

For example, a missing `NEEDS HUMAN WHEN` section should identify that exact label,
explain that the investigator needs an explicit uncertainty boundary, and instruct
the author to add the label after `FALSE POSITIVE SIGNALS` with non-empty guidance.
A table rejection should identify the table-formatting problem and recommend
converting each row into a short sentence in the appropriate section.

The Console validates while an operator writes and disables submission while known
issues remain. Backend validation still returns structured issues if the content was
submitted by another client or changed outside the current editor. Correct every
reported issue and submit again; a rejected request never creates a partial catalog
revision or retrieval projection.

## Save, edit, and delete

A successful create or update saves one durable operator revision and immediately
attempts to project the complete guidance into the `runbook` retrieval corpus. The
response reports the saved revision and index result separately so a temporary
embedding or vector-store failure cannot be mistaken for a lost edit.

When editing, the Console supplies the revision it opened. If another operator saved
a newer revision first, the backend rejects the stale replacement; reload, compare,
and apply the intended change to the current document. Deletion has the same stale-
revision protection. Bundled Runbooks remain protected.

Deleting an operator Runbook removes its managed content and attempts to remove only
that Runbook's retrieval projection. It does not clear imported knowledge, MITRE
content, suppression guidance, resolved-case memory, playbooks, or historical case
records.

Every create, update, delete, and reindex operation is attributable in the append-only
audit log. Existing investigations keep their recorded provenance; changes apply to
future retrieval or an explicit re-investigation.

## Reindex and recover

Create and update normally keep retrieval synchronized. Use **Reindex** when an item
reports a failed or stale projection, after restoring an embedding or vector service,
or when an administrator needs to reconcile the catalog deliberately.

- Item reindex replaces only the selected Runbook projection.
- Catalog reindex reconciles bundled and operator Runbooks and removes only stale
  `runbook` projections.
- Reindex never clears unrelated knowledge documents.
- The result reports indexed, deleted, and failed counts plus bounded errors. A
  partial result remains visible and retryable instead of being labelled successful.

Reindex submits a `runbook_reindex` background job, with an optional immutable
Runbook ID for a targeted reconciliation. The dialog closes after `202 Accepted`;
progress, cooperative cancellation, counts, and bounded failures stay available in
**Analytics → Jobs** and **Inbox** across navigation or reload. A lease-expired
in-progress reindex item is safe to retry, while already recorded items are not run
again. Reindex remains advisory retrieval maintenance and never changes the authored
revision or deterministic case policy.

The direct full-catalog `POST /api/runbooks/reindex` route remains executable for
compatibility clients, but it is OpenAPI-deprecated and request-bound; it is not the
Console workflow. Direct `POST /api/runbooks/{runbook_id}/reindex` remains the normal
targeted catalog primitive.

Reindexing existing content does not create a new authoring revision and does not
retroactively apply the current submission rules. An operator must bring legacy
content into compliance when saving its next edit.

If RAG or Runbook retrieval is disabled, the catalog remains available for management
but the Console says that retrieval is inactive. Enabling it affects future retrieval;
it does not rewrite an earlier case.

## Trust and decision boundary

Runbooks are an administrator-controlled trusted knowledge source. Restrict
`runbooks:manage` to people who review investigation guidance, because body text can
be presented to a model as trusted reference material. Source logs, imported
documents, and unknown corpus sources remain fenced as untrusted data; adding them to
an operator Runbook is not a safe way to promote their claims.

Retrieval is advisory. The model may use a matching Runbook to explain evidence and
recommend a verdict, but deterministic operator policy remains the only close or
escalate authority. `NEEDS_HUMAN` can never auto-close.

See [Knowledge and memory](knowledge-memory.md),
[Background jobs](../operations/background-jobs.md),
[Investigation](../analyst/investigation.md), and
[Permissions](../reference/permissions.md).
