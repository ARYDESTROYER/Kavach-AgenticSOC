# Runbooks: how the industry does it, and what one rebuilt Runbooks feature should be

Round 14, Ask 9. Research brief (external research plus a short look at today's code).
Written 2026-10-25. Status: research only, nothing implemented.

The operator's ask, verbatim: "Can we please merge playbooks and runbooks pls, too
complicated, just remove both and redo runbooks from scracth how they work redo it pls, do
it per the best cybersecuirty and how other do it standards. You may also refer to
https://asp.viperrtp.com."

## 0. Bottom line

1. **The industry does not agree on the words, but it agrees on the object.** "Runbook",
   "playbook", "workbook", "response plan", "incident tasks" and "case template" all name the
   same thing in different products: a reviewed, versioned procedure for one kind of
   incident, broken into phases and steps, attached to a case by conditions (detection rule,
   incident type, severity, MITRE technique), and worked through per case as a checklist
   with owner, status, notes, evidence and timestamps. Some steps are done by a person, some
   are done by the machine. (Sections 2, 4, 5.)
2. **Agentic SOC should ship exactly one feature called Runbooks** and define the word in the
   product: "A runbook is the step-by-step response procedure for one kind of case. People
   follow it, the AI helps with it, and it never closes a case by itself." Both current
   features (Reference runbooks and Response playbooks) go away.
3. **The core of the new feature is the per-case run**, not the library page. Today neither
   feature has a per-case checklist; the closest thing is the free-form Case tasks list.
   Every leading tool (Splunk ES response plans, Splunk SOAR workbooks, Microsoft Sentinel
   incident tasks, XSOAR Work Plan, TheHive case templates, Torq runbooks) shows a progress
   checklist inside the case. That is the piece analysts actually feel.
4. **Steps come in five kinds:** Check (a human verifies something), Lookup (a read-only
   query the suite runs itself and attaches as evidence), Decision (a human picks a branch),
   Action (a human performs a response action outside the suite and records it), and Record
   (notify, document, hand off). This covers CACAO's manual commands and conditions, XSOAR's
   manual and conditional tasks, Elastic's investigation-guide query buttons and Splunk's
   task actions, without the suite ever executing a destructive action.
5. **Matching is deterministic and explainable**, reusing today's playbook match contract
   (rule, MITRE technique, entity types, severity, source, tags) and adding verdict and
   status conditions. The case shows why a runbook attached. AI suggestion is a second,
   optional path when nothing matches, and a human accepts it.
6. **AI helps, humans decide.** The agent can suggest a runbook, run the read-only Lookup
   steps, draft a note for a step, and answer "what is next on this case". It never ticks a
   human step, never performs containment, and never changes `AutoClosePolicy` or
   `decide()` (#3). Only a published, reviewed runbook version counts as trusted operator
   guidance for the investigator; every case value and lookup result stays untrusted (#9).
7. **Versioning and review are not optional.** Runbook text steers the investigator as
   trusted guidance, so authoring needs Draft, In review, Published, Retired states, a
   recorded approver, a review-due date, and pinned versions per case ("changes only apply
   to future uses", as Splunk SOAR puts it).
8. **Ship a starter library of about 12 runbooks** that merges today's 18 bundled files into
   one set, organised by NIST SP 800-61r3 / SANS phases and mapped to MITRE ATT&CK,
   D3FEND and RE&CT response actions.
9. **Native format is Markdown with front matter** (readable, diffable, matches the current
   parser style); offer CACAO v2.0 JSON export and import of manual steps only.
10. **Measure honestly:** usage, completion rate, time per step, skipped steps, coverage of
   human-handled cases. Never claim the runbook "caused" an MTTR change; show with and
   without cohorts with sample sizes, in line with the repo's evidence contracts.

## 1. What exists today, and why it confuses

Two separate features with overlapping content and different rules:

| | Reference runbooks | Response playbooks |
|---|---|---|
| Page title and subtitle | "Reference runbooks: Trusted investigation guidance retrieved as reference knowledge; never executable authority." | "Response playbooks: Operator procedures selected deterministically to guide an investigation; never decision authority." |
| Code | `backend/app/engine/runbooks.py:1-31` (plain-text body with fixed labels SIGNAL, EVIDENCE REQUIRED, INVESTIGATION STEPS, TRUE POSITIVE SIGNALS, FALSE POSITIVE SIGNALS, NEEDS HUMAN WHEN, RECOMMENDED NEXT ACTION, optional LIMITATIONS at `:72-81`), store `backend/app/stores/runbooks.py`, routes `backend/app/api/routes_runbooks.py` | Markdown with a match contract (`rule_ids`, `entity_types`, `min_event_count`, `mitre`, `any_tags`), `priority`, `suggested_tools`, `rag_queries`, `escalate_if`, `suggested_verdict_bias` (`backend/playbooks/README.md`), registry `backend/app/playbooks/registry.py`, store `backend/app/stores/playbooks.py` |
| How it reaches the AI | Retrieved by fuzzy RAG score into the investigator context | Selected deterministically and injected as TRUSTED procedure text (`backend/app/agents/investigator.py:142-189`) |
| Bundled content | 9 files in `backend/app/runbooks/` | 9 files in `backend/playbooks/` |
| What an analyst can do with it in a case | Nothing visible | Nothing visible beyond "which playbook was selected" provenance |
| Navigation | Intelligence, Reference runbooks (`webui/src/soc/registry.tsx:315`) | Intelligence, Response playbooks (`webui/src/soc/registry.tsx:327`) |

Screenshots of today's pages (shared demo, dark theme, 1440 px):
- `<scratch>/r14/notes/rbshots/cur-runbooks.png`
- `<scratch>/r14/notes/rbshots/cur-playbooks.png`

What the screenshots show: internal vocabulary on the surface ("Reindex", "Selection
context rev 1", "priority 50", "Runnable", "11.4% covered", "Bundled", "Package"), two
lists of near-duplicate topics (brute force, cloud identity, data exfiltration, web attack
appear on both), and no link from either list to the work an analyst does in a case.

Overlap between the two bundled sets:

| Topic | Runbook file | Playbook file |
|---|---|---|
| Brute force / password spray | `brute_force.md` | `brute_force_login.md` |
| Cloud identity compromise | `cloud_iam_compromise.md` | `cloud_identity_compromise.md` |
| Data exfiltration | `data_exfiltration.md` | `data_exfiltration_response.md` |
| Phishing / mail abuse | `mail_abuse.md` | `phishing_reported_email.md` |
| Web attack | `web_attack.md` | `web_application_abuse.md` |
| Scanning | `port_scan.md`, `vuln_scan.md` | `web_scanner_activity.md` |
| Known-bad IP / outbound | `ip_reputation.md` | `suspicious_outbound_connection.md` |
| Malware / ransomware | `malware.md` | `ransomware_response.md` |
| Privileged access | (none) | `privileged_web_access.md` |

A separate, already-built piece matters for the redesign: per-case tasks exist
(`backend/app/models.py:1078` `CaseTask` with `open | in_progress | done | blocked`, a stable
`order` and an append-only `logs` trail; store `backend/app/stores/case_tasks.py`; shown in
the Case detail Collaboration tab with an "N open" count). This is the natural foundation for
runbook step tracking.

## 2. Runbook vs playbook vs workbook: definitions and how tools merge them

### 2.1 The words, as sources actually use them

- **Rootly glossary:** a runbook is "a precise, step-by-step procedure for completing one
  specific technical task", a playbook is "a higher-level guide for navigating an entire
  class of situations" (https://docs.rootly.com/glossary/runbook-vs-playbook).
- **Sumo Logic** uses the opposite split for security: runbooks are conditional automated
  steps (enrichment, containment, notification), playbooks are processes that rely on tasks
  a human performs, such as breach notification
  (https://www.sumologic.com/blog/the-difference-between-playbooks-and-runbooks-in-incident-response/).
- **TechTarget and Cortex (cortex.io)** say the two terms are used interchangeably
  (https://www.techtarget.com/it-infrastructure/tip/Compare-runbooks-vs-playbooks-for-IT-process-documentation,
  https://www.cortex.io/post/runbooks-vs-playbooks).
- **NIST SP 800-61r3 (April 2025), section 2.3, p. 9:** "Many organizations choose to create
  playbooks as part of documenting their procedures. Playbooks provide actionable steps or
  tasks for people to perform during various scenarios or situations."
  (https://csrc.nist.gov/pubs/sp/800/61/r3/final). NIST's "playbook" is a human procedure.
- **Microsoft** uses "playbook" for both: human incident response playbooks with a
  checklist (https://learn.microsoft.com/en-us/security/operations/incident-response-playbooks)
  and Logic Apps automation in Sentinel
  (https://learn.microsoft.com/en-us/azure/sentinel/automate-incident-handling-with-automation-rules).
- **OASIS CACAO v2.0:** a playbook is a workflow of steps that may be automated or manual;
  a `manual` command is "intended to be processed by a human or a system that acts on behalf
  of a human" (https://docs.oasis-open.org/cacao/security-playbooks/v2.0/security-playbooks-v2.0.html,
  section 5.3).
- **Splunk SOAR:** "Workbooks are lists of standard tasks that analysts follow when they
  evaluate events or cases"; playbooks are the automation
  (https://help.splunk.com/en/splunk-soar/soar-on-premises/administer-soar-on-premises/8.7.0/configure-product-settings-for-your-splunk-soar-on-premises-instance/define-tasks-using-workbooks).
- **ASP (the operator's reference)** has no "runbook" at all; its "Playbook" is an automated
  job run from a case (section 3).

Conclusion: the terms are inconsistent across the industry. A product must pick one word and
define it on screen. Since the operator chose "Runbooks", use that and never show "playbook"
again in the Console.

### 2.2 How leading tools merge the human procedure and the automation

| Product | Human procedure object | Automation object | How they merge |
|---|---|---|---|
| Splunk SOAR | Workbook: phases, tasks, owner or role, instructions, SLA | Playbook | A task can trigger actions and playbooks "when this task is performed"; a case shows its workbook as a checklist. |
| Splunk ES 8 | Response plan: phases, tasks | SOAR actions and playbooks, embedded searches | Each task has a Respond section with an embedded search and runnable action, plus Notes and Files (https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.7/mission-control/respond-to-investigations-with-response-plans-in-splunk-enterprise-security). |
| Cortex XSOAR / XSIAM | Manual tasks, manual conditional tasks, data collection (ask) inside the playbook | Automated tasks in the same playbook | One flow; the incident's Work Plan is "visual representation of the running playbook that is assigned to the incident" (https://cortex-docs.paloaltonetworks.com/cortex-xsoar-8-saas/investigate-and-respond-to-threats/incidents-and-indicators-investigation/investigate-an-incident). |
| Microsoft Sentinel | Incident tasks (a checklist on the incident) | Automation rules and Logic Apps playbooks | Automation rules add tasks by analytics rule; playbooks can add a task, try it, and mark it complete or leave it for the analyst (https://learn.microsoft.com/en-us/azure/sentinel/incident-tasks). |
| Torq HyperSOC | Runbook attached to each case | Socrates AI turns it into an "Actionplan" | The AI executes "the Actionplan generated from the runbook associated with the case" and asks the analyst for approval when needed, for example before closing (https://kb.torq.io/en/articles/9734818-socrates-transform-case-investigations). |
| FireHydrant | Runbook with an "Add Task List" step | Runbook automation steps | One runbook holds both; attached by conditions (https://docs.firehydrant.com/docs/runbook-conditions). |
| Elastic Security | Investigation guide (Markdown on the rule) | Investigate query buttons and Osquery buttons inside the guide | Read-only lookups are buttons inside the procedure (https://www.elastic.co/docs/solutions/security/detect-and-alert/write-investigation-guides). |
| TheHive | Case template with tasks | Cortex analyzers and responders | Template per threat category creates the task list (https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-templates/case-templates/about-case-templates/). |
| ASP | Knowledge entries (Markdown steps) | Playbook (Python job) | Separate; no checklist (section 3). |

The pattern: one case-attached procedure object that contains human steps and machine
steps, worked through as a checklist inside the case, with every step's who, when and what
recorded. This is what Agentic SOC should build, minus any step that changes an external
system.

## 3. The operator's reference: ASP (asp.viperrtp.com)

**What it is.** "Agentic SOC Platform" (ASP), open-source (MIT), self-hosted, by Funnywolf,
GitHub https://github.com/FunnyWolf/agentic-soc-platform. Tagline "Converge alerts into
Cases". Its loop: Alert intake, Case triage, AI investigation, Playbook automation, Reusable
knowledge (https://asp.viperrtp.com). Latest release 0.6.0 "Winter is Coming"
(https://asp.viperrtp.com/release/0_6_0_Winter_is_Coming/). Note: ASP is an unrelated
product that happens to use the generic phrase "Agentic SOC"; it is a design reference only.

**Terminology.** ASP never uses "runbook". Its glossary
(https://asp.viperrtp.com/asp/overview/glossary.md) defines a Playbook as an automated task
launched from a Case and tracked through statuses, and Knowledge as reusable guidance
maintained by hand or drawn from closed Cases.

**How a Playbook works** (https://asp.viperrtp.com/asp/workspace/playbook/,
https://asp.viperrtp.com/asp/development/playbook.md):
- Defined in code: a Python class `Playbook(BasePlaybook)` with `NAME`, `DESC`, `TAGS` and a
  `run()` method that reads `self.case` and `self.user_input`. Prompts live in Markdown files
  per playbook and language.
- Run only from a Case: a lightning icon in the case header opens "Run Playbook"; the dialog
  lists playbooks with name, tags and description, searchable, plus an optional
  natural-language "User Input".
- Each run is a record: `PLAYBOOK_000004`, Status `Pending → Running → Success / Failed`,
  Case link, User, Job ID, User Input, Remark (summary or failure reason). 0.6.0 added start
  and finish times, duration, a sanitized message stream (secrets masked, 1000 characters per
  message) and an automatic interruption remark when a worker dies.
- Built-ins: Investigation (AI report), Knowledge Extraction (only for cases with an analyst
  verdict), Threat Intelligence Enrichment, CMDB Enrichment, Case Summary. Results are
  written back to the Case, Knowledge or Enrichment, not kept in the run log.
- Authors can ask an agent skill (`asp-playbook-creator`) to draft new playbooks
  (https://asp.viperrtp.com/asp/integrations/skills/asp-playbook-creator.md).

**Knowledge** (https://asp.viperrtp.com/asp/workspace/knowledge.md): Markdown body for
"structured analysis steps, judgment basis, and response recommendations", Source Manual or
Case, tags, an Expires At date (expired entries leave search and agent retrieval), at most one
extracted entry per case. No review states.

**Case** (https://asp.viperrtp.com/asp/workspace/case.md): manual and AI-proposed severity,
confidence, impact, priority and verdict side by side; the AI report contains "response
recommendations"; no checklist or task concept; comments feed the AI context.

**Screenshots** (downloaded from ASP's public docs):
- Playbook run list: `<scratch>/r14/notes/rbshots/asp-img.CcLueN_g.png`
  (dark table: Playbook ID, Name, Status with green "Success", Case link, User, Job ID,
  Created and Updated time, User Input, delete action; quick filter by Status).
- Run Playbook entry on a case: `<scratch>/r14/notes/rbshots/asp-img_0.B0Y86DL3.png`
  (case drawer header with the lightning icon highlighted; fields in a four-column grid,
  manual and "(AI)" assessments in matching rows).
- Run detail: `<scratch>/r14/notes/rbshots/asp-img_2.DkUYgnyM.png`
  ("Input & Result" section with User Input and Remark).

**What to take from ASP:**
1. One button on the case ("Run") with a searchable picker and an optional instruction
   field is a simple, fast interaction. Agentic SOC should have the equivalent: "Start
   runbook" on the case, searchable, with the matched one pre-selected.
2. Every run is a durable, listable record with status, who, when, duration and result,
   and results land back in the case. Agentic SOC's per-case run should be the same, and
   the library should show recent runs.
3. "Knowledge extraction only after an analyst verdict" is a good governance idea: drafting
   a runbook from a case should only be offered for human-confirmed cases, and the result
   starts as a draft.
4. Where ASP is thin, the industry is not: ASP has no checklist, no phases, no approvals, no
   versioning, no review. The rebuilt Runbooks feature should go further than ASP on all of
   these, using Splunk, Sentinel, XSOAR and CACAO as the standard.

## 4. Standards and frameworks

### 4.1 NIST SP 800-61 Rev. 3 and CSF 2.0
Source: https://csrc.nist.gov/pubs/sp/800/61/r3/final (final, April 2025, supersedes Rev. 2
from 2012). Read from the PDF.
- Rev. 3 replaces the old four-stage circle with a model based on the six CSF 2.0 Functions:
  Govern, Identify, Protect (preparation, not incident response itself), and Detect,
  Respond, Recover (incident response), with Improvement (ID.IM) fed continuously, not only
  after recovery (section 2.1, Fig. 2).
- Section 2.3: procedures "should explain how technical processes and other operating
  procedures should be performed", can be exercised to verify them and train new staff, and
  organizations "should consider documenting procedures for responding to the most common
  types of incidents and threats". Playbooks "provide actionable steps or tasks for people to
  perform". It points to the CISA playbooks as examples.
- Respond subcategories that a runbook should map to:
  - RS.MA-01 plan executed once an incident is declared (C1: designate an incident lead).
  - RS.MA-02 triage and validate (estimate severity and urgency).
  - RS.MA-03 categorize (data breach, ransomware, account takeover, denial of service) and
    prioritize.
  - RS.MA-04 escalate or elevate; "Track and validate the status of all ongoing incidents".
  - RS.MA-05 apply criteria for initiating recovery.
  - RS.AN-03 establish sequence of events and root cause.
  - RS.AN-06 "Actions performed during an investigation are recorded, and the records'
    integrity and provenance are preserved."
  - RS.AN-07 incident data and metadata collected with integrity and provenance.
  - RS.AN-08 magnitude estimated and validated.
  - RS.MI-01 contain; R1 "Allow incident handlers to manually select and perform containment
    actions instead of or in addition to automated containment measures."
  - RS.MI-02 eradicate; RC.RP-01 to RC.RP-06 recovery, ending with an after-action report;
    RC.CO-03 and RC.CO-04 recovery communication.

Implication: RS.AN-06 is exactly the per-step audit trail (#2). RS.MI-01 R1 supports a design
where containment is a human-performed step, which matches the suite's read-only rule.

### 4.2 SANS Incident Handler's Handbook (PICERL)
Patrick Kral, SANS, 21 February 2012 (https://www.sans.org/white-papers/33901/): six phases,
Preparation, Identification, Containment, Eradication, Recovery, Lessons learned, and an
"incident handler's checklist template" for confirming each step is followed. PICERL is the
phase vocabulary most analysts know; RE&CT uses the same six stages.

### 4.3 CISA Federal Incident and Vulnerability Response Playbooks
November 2021 (https://www.cisa.gov/sites/default/files/publications/Federal_Government_Cybersecurity_Incident_and_Vulnerability_Response_Playbooks_508C.pdf).
- Phases: Preparation, Detection and Analysis, Containment, Eradication and Recovery,
  Post-Incident Activities, plus Coordination.
- "Appendix B provides a companion checklist to track activities to completion." The
  checklist columns are Step, Incident Response Procedure, Action Taken, Date Completed, with
  numbered sub-steps (1a Perform initial categorization, 1b Designate incident coordination
  lead, 2a Identify the type and extent, 3b "Log all evidence and note how the evidence was
  acquired, when it was acquired, and who acquired the evidence", 4b form a hypothesis).
- Agencies "must proactively provide completed incident response checklists and a completed
  incident report to close the ticket."
- A separate Vulnerability Response Playbook covers identification, evaluation, remediation
  and reporting.

Implication: the per-case run is the checklist; a "required before resolve" flag on steps
matches CISA's "completed checklist to close", applied only to human closure (section 8.6).

### 4.4 OASIS CACAO Security Playbooks v2.0
Committee Specification 01, 27 November 2023
(https://docs.oasis-open.org/cacao/security-playbooks/v2.0/security-playbooks-v2.0.html).
- Playbook types: attack, detection, engagement, investigation, mitigation, notification,
  prevention, remediation; each has playbook activities (investigation requires
  identify-indicators; mitigation requires eliminate-risk; remediation requires
  restore-capabilities).
- Required top-level properties: `type`, `spec_version`, `id`, `name`, `created_by`,
  `created`, `modified`, `workflow_start`, `workflow`. Useful optional ones: `description`,
  `playbook_types`, `playbook_activities`, `revoked`, `valid_from`, `valid_until`,
  `derived_from`, `priority`, `severity`, `impact`, `labels`, `external_references`,
  `playbook_variables`, `agent_definitions`, `target_definitions`, `signatures`.
- Step types: `start`, `end`, `action` (needs `commands` and `agent`; optional `targets`,
  `in_args`, `out_args`), `playbook-action` (call another playbook), `parallel`,
  `if-condition`, `while-condition`, `switch-condition`. Common step fields include `name`,
  `description`, `delay`, `timeout`, `step_variables`, `owner`, and `on_completion` or
  `on_success`/`on_failure`.
- Command types: `manual`, `bash`, `caldera-cmd`, `elastic`, `http-api`, `jupyter`,
  `kestrel`, `openc2-http`, `powershell`, `ssh`, `sigma`, `yara`. Example manual command:
  `{"type": "manual", "command": "Disconnect the machine from the network and call the SOC
  on-call person"}`.
- Agents include `individual`, `group`, `organization`, `location`, `sector`.
- Versioning: "A version of a playbook is identified uniquely by the combination of its id
  and modified properties"; the first version has `created == modified`; only the creator
  issues new versions, others create a new playbook with `derived_from`; revocation is
  permanent. Signatures (JSON Signature Scheme over an RFC 8785 canonical form) can be
  embedded or detached, and adding one "does not constitute a revision".
- CACAO defines no trigger model: playbooks may run ad hoc, on a schedule, or from an event,
  and matching is left to the product.

Implication: CACAO is the right interchange format for export, and its version identity
(id plus modified) and `derived_from` (clone of a built-in) are good rules to adopt. Its
automated command types are out of scope for a read-only suite; on import they can only
become human Action steps with the command shown as text.

### 4.5 RE&CT, MITRE D3FEND, MITRE ATT&CK
- **RE&CT** (https://atc-project.github.io/atc-react/): an ATT&CK-style matrix of atomic
  response actions. Stages 1 to 6 (Preparation, Identification, Containment, Eradication,
  Recovery, Lessons Learned) and categories 0 General, 1 Network, 2 Email, 3 File, 4 Process,
  5 Configuration, 6 Identity. Examples: RA2001 List victims of security alert, RA2204 Make
  sure email message is phishing, RA3101 Block external IP address, RA3203 Quarantine email
  message, RA3601 Lock user account, RA4601 Revoke authentication credentials, RA5002 Restore
  data from backup, RA6001 Develop incident report. Response playbooks (RP0001 Phishing email)
  are lists of RAs, stored as YAML and rendered to Markdown and TheHive case templates.
- **D3FEND** (https://d3fend.mitre.org/, ontology 1.6.0): defensive tactics Model, Harden,
  Detect, Isolate, Deceive, Evict, Restore; for example Network Isolation, Account Locking,
  Credential Revocation, Process Termination, File Eviction, Reissue Credential, Restore File.
- **ATT&CK**: the suite already maps cases to techniques (`Case.mitre`, `engine/mitre.py`)
  and ships a 697-technique corpus, so runbooks can be matched by technique and coverage can
  be shown per tactic.

Implication: tag each Action step with an optional RE&CT RA id and D3FEND technique. This
gives a standard vocabulary for "what kind of response this step is" and enables coverage
views ("techniques with a runbook", "response actions used most").

## 5. Products, one by one

### 5.1 Cortex XSOAR and XSIAM (Palo Alto Networks)
- A playbook is "a series of tasks, conditions, scripts, conditions, commands, and loops that
  run in a predefined flow" (https://cortex-docs.paloaltonetworks.com/cortex-xsiam-developer-guide/cortex-xsiam-development-guide/playbooks.md).
- Task kinds: standard tasks (manual or automated), conditional tasks (Built-in, Manual "must
  be manually resolved", Ask a single-question survey, Choose script), communication / data
  collection tasks, section headers and sub-playbooks
  (https://cortex-docs.paloaltonetworks.com/cortex-xsoar-8-saas/configure-cortex-xsoar/playbooks/develop-your-playbook/task-3.-add-tasks/create-a-conditional-task).
- Manual task options: default assignee, "Stop the playbook from proceeding until the task
  assignee completes the task", reminder, Task SLA and SLA breach handling, timers
  (Start, Stop, Pause) on SLA fields, "mark results as note or evidence", questions with
  answer types including attachments and a Mandatory flag
  (https://xsoar.pan.dev/docs/playbooks/playbooks-field-reference).
- Triggers: by incident or issue type; XSIAM playbook triggers filter alerts by source,
  severity or MITRE TTP, evaluated in order, first match only
  (https://docs-cortex.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-Documentation/Add-a-playbook-trigger-to-an-alert).
- Sub-playbooks declare inputs and outputs with defaults.
- Per incident: the War Room is a "chronological journal" of the investigation, the
  Evidence Board collects items flagged as evidence, the Work Plan shows the running
  playbook.

Take: manual decision tasks, mandatory answers, evidence flags, SLA timers and an ordered,
first-match trigger list are mature, proven ideas.

### 5.2 Splunk SOAR workbooks and Splunk ES response plans
- Workbook: phases (at least one, optional SLA) containing tasks with owner or role,
  instructions and SLA; tasks can run actions and playbooks; "Changes to a workbook only
  apply to future uses of the workbook" (URL in 2.1).
- In a case (https://help.splunk.com/en/splunk-soar/soar-on-premises/use-splunk-soar-on-premises/8.7.0/manage-cases-in-splunk-soar-on-premises/define-a-workflow-in-a-case-using-workbooks-in-splunk-soar-on-premises):
  the Workbook tab, task progress status, per-case edits that only affect that case, an
  option to require a note before completion, a checkmark when complete, revert to
  Incomplete, and notifications when assigned to a role.
- ES 8 response plans: apply to an investigation, or assign to an investigation type so new
  ones get it; Response tab shows the current phase and task count; Start (auto-assigns to
  you), Owner, End, reopen; per task a Respond section (embedded search over the last 24
  hours by default, runnable action or playbook, View results), Notes (title up to 250,
  description up to 10,000 characters), Files; "Review and complete all the tasks in a phase
  to end a phase"; several plans per investigation; clone a built-in plan to customise.
- Built-in plans: Account Compromise, Data Breach, Network Indicator Enrichment, NIST 800-61,
  Generic Incident Response (detect, analyze, contain, eradicate, recover, review),
  Self-Replicating Malware, Suspicious Email, Vulnerability Disclosure
  (https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/response/included-response-plans-in-splunk-enterprise-security).

Take: this is the closest model to what Agentic SOC needs: phases, tasks, embedded read-only
searches inside a task, notes and files per task, pinned versions, clone-to-customise.

### 5.3 Microsoft Sentinel and Defender
- Incident tasks (https://learn.microsoft.com/en-us/azure/sentinel/incident-tasks): the goal
  is "standardization of processes" so that "regardless of who is on-shift, an incident will
  always get the same treatment and SLAs". Tasks appear in a right-hand panel on the incident;
  expanding one shows its description and who created it (user, automation rule or
  playbook); complete with a checkbox circle; analysts can add tasks on the spot (that
  incident only). Automation rules add tasks scoped by analytics rule name; order follows
  creation time; a playbook can add a task, attempt it, and mark it complete or leave it for
  a person. Guidance: automation rules for "plain, static tasks", playbooks for conditional
  tasks or tasks with automated actions.
- Automation rules: triggers incident created, incident updated, alert created; conditions on
  analytics rule, incident and entity properties, and state changes; actions add task, change
  status, severity, owner, tag, run playbook; ordered; optional expiration; export and import
  as JSON. An incident is described as a "case file", and incident-triggered automation is
  preferred.
- Screenshot of the Sentinel incident tasks panel (Microsoft Learn):
  `<scratch>/r14/notes/rbshots/sentinel-incident-tasks.png`.
  It shows a progress bar "1/6 completed", Search and Status filter, task rows each with a
  circle checkbox, title and "Created by: Automation rule - Brute force attack workflow" or
  "Created by: Playbook", completed rows dimmed with a filled check, and a "Tasks 1/6
  completed" summary on the incident's left rail.
- Microsoft IR playbooks (Phishing, Password spray, App consent grant, Compromised and
  malicious applications) each have Prerequisites, Workflow, Checklist ("helpful in highly
  regulated environments to verify what you have done") and Investigation steps.
- Defender XDR "guided response" (Security Copilot) recommends triage, containment,
  investigation and remediation steps inside the incident
  (https://techcommunity.microsoft.com/blog/microsoftthreatprotectionblog/-/4416350,
  https://microsoft.github.io/zerotrustassessment/ja/docs/workshop-guidance/securityoperations/SVA_AI006).

Take: the per-incident checklist with provenance ("created by") and a progress fraction is
the clearest, most familiar analyst UI. Prerequisites are a useful runbook section.

### 5.4 Google SecOps SOAR
- Playbooks start from triggers (rule name, severity, log type, combinations), are built from
  actions and reusable blocks, and can include "manual approval steps" so analysts review
  proposed actions such as isolating a host or blocking an IP; they can "pause and present
  analysts with yes-no questions"; an Isolate Host action can sit "pending approval"
  (https://docs.cloud.google.com/chronicle/docs/secops/respond-cases;
  community tip https://security.googlecloudcommunity.com/tuesday-s-tip-of-the-week-93/tuesday-s-tip-of-the-week-designing-playbooks-automation-without-chaos-8207).

Take: yes-no decision steps and approval-pending states are standard UI vocabulary.

### 5.5 CrowdStrike Falcon Fusion, Tines, Torq, Swimlane
- Falcon Fusion: triggers on demand, on a schedule or on platform events (detection,
  incident); CEL conditions; a "Request Human Input" capability
  (https://www.crowdstrike.com/en-us/blog/new-falcon-fusion-features-refine-workflow-automation/,
  https://developer.crowdstrike.com/ngsiem/fusion-soar/).
- Tines: approval gates through Pages (forms) with a decided timeout behaviour
  (https://community.tines.com/t/how-do-i-build-a-human-in-the-loop-approval-workflow/30,
  https://tines.com/blog/humans-in-the-loop-of-ai).
- Torq: each case has a runbook; the AI analyst works through the Actionplan derived from it,
  reports completed runbook tasks, asks for approval when needed, logs its messages in the
  case activity log and its actions in the audit log as acting on the user's behalf
  (https://kb.torq.io/en/articles/9734818-socrates-transform-case-investigations). A
  reviewer complained about the lack of "git-like version control" when publishing workflows
  (https://aws.amazon.com/marketplace/reviews/reviews-list/prodview-2c4o6nqsvkxhy?page=8).
- Swimlane Turbine: drag AI agents into playbooks, with playbooks enforcing guardrails and
  human-in-the-loop validation
  (https://www.businesswire.com/news/home/20260127331259/en/Swimlane-Unveils-Fleet-of-AI-Agents-and-Agent-Builder-to-Power-the-Security-Workforce).

Take: the "AI-native" products keep a human-readable runbook as the source of truth and let
the AI work through it, with approvals and attribution. This is the right shape for an
agentic SOC, and it fits Agentic SOC's non-negotiables if the AI's actions are limited to
reads, drafts and suggestions.

### 5.6 TheHive
Case templates per threat category prefill fields and tasks; a template can be applied to an
existing case; templates are exported and imported; only users with `manageCaseTemplate` can
manage them (URL in 2.2). A mandatory task needs at least one task log before it can be
marked Completed, and starting a task sets In progress
(https://docs.strangebee.com/thehive/user-guides/analyst-corner/tasks/change-task-status/).

Take: "evidence required before done" is a simple, effective quality control.

### 5.7 Elastic Security investigation guides (rule-attached runbooks)
- Investigation guides are "Markdown documents attached to detection rules"; query buttons
  run a query built from alert field values and show the count of matching documents; Osquery
  buttons fill placeholders from the alert (https://www.elastic.co/docs/solutions/security/detect-and-alert/write-investigation-guides,
  https://www.elastic.co/docs/solutions/security/investigate/run-osquery-from-investigation-guides).
- A current prebuilt rule (updated 2026/09/18,
  https://github.com/elastic/detection-rules/blob/main/rules/windows/impact_volume_shadow_copy_deletion_or_resized_via_vssadmin.toml)
  shows the house structure:
  - "Triage and analysis", then "Possible investigation steps", each step written as a
    **question** ("Does the launcher and account explain why VssAdmin changed shadow-copy
    state?") with **Focus** (which fields to look at) and **Implication** ("escalate when ...;
    lower suspicion when ..."), plus a `$investigate_N` button.
  - "False positive analysis", including how to scope an exception narrowly.
  - "Response and remediation" split by outcome: If confirmed benign, If suspicious but
    unconfirmed ("Apply reversible containment first"), If confirmed malicious, restore, and
    post-incident hardening.
  - The buttons are declarative, read-only queries: `[[transform.investigate]]` with a label,
    field filters templated from the alert (`{{user.id}}`, `{{host.id}}`) and a relative
    window (`now-48h/h` to `now`).

Take: this is the best public example of a rule-attached procedure with built-in read-only
lookups. The "question, focus, implication" step shape and the outcome-split response section
should be the house style for Agentic SOC's built-in runbooks. Today's runbook labels
(TRUE POSITIVE SIGNALS, FALSE POSITIVE SIGNALS, NEEDS HUMAN WHEN) already carry the same
idea and can be folded in.

### 5.8 Incident management and SRE practice (PagerDuty, Rootly, FireHydrant, Google SRE)
- Google SRE book: "thinking through and recording the best practices ahead of time" in a
  playbook "produces roughly a 3x improvement in MTTR as compared to the strategy of "winging
  it."" (https://sre.google/sre-book/introduction/). This is an internal Google observation,
  not a controlled study; cite it as motivation only.
- FireHydrant runbooks: runbook-level conditions decide attachment (for example SEV1 only),
  incidents are scanned continuously so a runbook can attach later (SEV2 escalated to SEV1
  attaches the SEV1 runbook), a runbook attaches once, step-level conditions decide when a
  step runs, and the default runbook adds a task list for the incident commander
  (https://docs.firehydrant.com/docs/runbook-conditions). Best practices: keep runbooks trim
  and single-purpose, make sure teams know a common runbook exists, use one "Always attach"
  primary runbook in small organizations, and test with a Test button that uses a GAMEDAY
  severity that does not affect analytics (https://docs.firehydrant.com/docs/runbook-best-practices).
- Rootly and PagerDuty: only vendor comparison pages were found (for example
  https://rootly.com/sre/rootly-vs-firehydrant-alert-management-software-comparison); they
  describe condition-based workflows by incident type, severity and service, and
  one-click runbook tasks from Slack. Treat as marketing.

Take: attach by conditions, re-evaluate when the case changes (severity raised, verdict
confirmed), attach once, and offer a safe test mode that never touches metrics.

### 5.9 Public runbook libraries
- AWS incident response playbooks (CC BY-SA 4.0; https://github.com/aws-samples/aws-incident-response-playbooks):
  Credential Compromise, STS Token Abuse, Identity Center Compromise, Federated Access Abuse,
  Insider Threat, EC2 Compromise, Container/EKS Compromise, CI/CD Compromise, Cryptomining,
  Ransomware, Denial of Service, Data Access, S3 Data Exfiltration, Root Account Takeover,
  Personal Data Breach, and five agent-workload playbooks.
- Microsoft (4), Splunk ES (8), CISA (incident and vulnerability), RE&CT (phishing).

## 6. Key UIs, described precisely

**Library list.** Splunk ES lists response plans with a three-dot menu (Clone). ASP lists run
records in a dense table with status chips. Sentinel lists automation rules with an Action
filter to see which rules add tasks and to which analytics rules. Common columns: name,
applies to (rule or type), status, owner, last modified, usage. Agentic SOC should add
"needs review" and "steps" columns.

**Editor.** XSOAR, Google SecOps, Tines, Torq and Swimlane use visual canvas editors (boxes
and arrows); Splunk SOAR workbooks and Splunk ES response plans use a phase list with task
rows and a side form; Sentinel's "Add task" is a title plus rich-text description; Elastic
and FireHydrant use a form plus a Markdown body. For a human-first, read-only runbook, the
Splunk-style structured outline (phases, then steps, a form on the right) is the right
level; a canvas adds complexity without value when there is no automated branching across
systems.

**Per-case run view.** Sentinel: right panel, progress bar and fraction, rows with checkbox,
title and "Created by", expand for description. Splunk ES: Response tab, phase selector with
task count, task detail with Start, Owner, End, Respond (embedded search and action, View
results), Notes, Files. XSOAR: Work Plan diagram with task states and a War Room journal.
ASP: run records listed on the case's Playbooks section. Torq: chat-style AI updates in the
case plus task completion.

## 7. Best practices extracted

### 7.1 Structure
- Runbook header: title, one-line purpose, scope ("use when"), prerequisites (logging and
  access needed, Microsoft), owner, version, last reviewed, references.
- Phases following NIST/SANS: Triage, Investigate (scope), Contain, Eradicate, Recover, Close
  and learn. Allow fewer phases; most SOC runbooks only need three or four.
- Steps: title, instructions, why it matters, expected evidence, owner role, required or
  optional, and for Checks the Elastic-style "escalate if / benign if" implication.
- Decision points with explicit options (XSOAR manual conditional, Google yes-no, CACAO
  if-condition and switch-condition).
- Approvals for high-impact actions (Google pending approval, Tines Pages, Torq approval
  before close).
- Optional time targets per phase or step, shorter than the phase target (Splunk SOAR).
- Outcome-split response guidance: benign, suspicious but unconfirmed, confirmed malicious
  (Elastic).

### 7.2 Triggers and matching
- Match on detection rule (all products), incident or investigation type (XSOAR, Splunk ES),
  severity (FireHydrant, XSIAM), MITRE technique (XSIAM), source or log type (XSIAM, Google),
  entity types (current Agentic SOC playbook contract), tags and verdict or status changes
  (Sentinel update trigger).
- Ordered evaluation with a clear winner (XSIAM first match, Sentinel order), plus a generic
  fallback (Splunk Generic Incident Response, FireHydrant "Always attach").
- Re-evaluate when the case changes, attach each runbook once (FireHydrant).
- Show why it attached (Sentinel "Created by", FireHydrant conditions).

### 7.3 Versioning, review and governance
- Version identity plus immutable history (CACAO id plus modified); clones keep
  `derived_from`.
- Running cases keep the version they started with (Splunk SOAR).
- Built-ins are read-only and cloned to customise (Splunk ES).
- Draft, review and publish with a named approver; review cadence; retire instead of delete.
  (Torq's missing version control is a known complaint.)
- Separate permissions to author and to publish (TheHive `manageCaseTemplate`, Sentinel
  Responder vs Logic Apps Contributor).
- Test before publishing without touching metrics (FireHydrant GAMEDAY).

### 7.4 Execution tracking per case
- Step status, assignee, started and completed time, completed by, notes, attached evidence
  (Splunk ES, Splunk SOAR, Sentinel, TheHive, XSOAR).
- Evidence-required steps cannot be marked done without a note or attachment (TheHive,
  Splunk SOAR).
- Ad-hoc tasks live alongside runbook tasks with provenance (Sentinel).
- Progress fraction visible on the case and in the queue (Sentinel).
- Everything is in the case's immutable activity record (NIST RS.AN-06, CISA 3b).

### 7.5 AI assistance (current practice)
- Recommend next steps and containment inside the case (Defender guided response).
- Execute the runbook's investigative steps and report progress, ask a human before
  consequential steps such as closing (Torq Socrates).
- Draft new procedures from closed cases, reviewed by people (ASP knowledge extraction and
  playbook creator, Torq runbook agent).
- Attribute every AI action in the audit log (Torq).

### 7.6 Metrics
- Usage per runbook, completion rate, time per step and per phase, skipped steps, SLA
  breaches (XSOAR timers, Splunk SLAs), coverage of detections with a runbook. NIST lists
  "performance measures" as a required policy element (section 2.3).

### 7.7 Library
Every reference library covers: phishing / suspicious email, malware on an endpoint,
ransomware, brute force and password spray, compromised account (impossible travel,
suspicious sign-in), cloud identity and key compromise, data exfiltration, web application
attack, scanning and reconnaissance, insider threat, denial of service, vulnerability
disclosure, and a generic incident fallback.

### 7.8 Formats
Markdown for humans (Elastic, Microsoft, AWS, RE&CT renders), YAML or TOML front matter for
metadata (Elastic TOML, RE&CT YAML), CACAO JSON for exchange, vendor JSON for automation rules
(Sentinel ARM).

## 8. Recommendation for Agentic SOC: one Runbooks feature

### 8.1 Concept
- **One nav item**, Intelligence, **Runbooks**. Remove "Reference runbooks" and "Response
  playbooks" (and the hidden `catalog` alias). The Console never says "playbook" again.
- **Definition shown on the page:** "Runbooks are your team's step-by-step response
  procedures. The matching runbook is attached to each case that needs a person. Analysts
  work through it as a checklist; the AI runs the read-only lookups and suggests notes. A
  runbook never closes a case; your case policy does that."
- **Three surfaces:** the library (list plus editor), the per-case run (Case detail and
  Case Manager), and the AI's use of it (investigator guidance, chat answers, prefilled
  lookups).

### 8.2 Runbook definition (what an author writes)

Runbook header fields:

| Field | Notes |
|---|---|
| `id`, `title`, `summary` | Slug id, plain title, one sentence. |
| `use_when` | Plain-language scope shown to analysts. |
| `applies_when` | Deterministic match (8.3). |
| `prerequisites` | Logging and access needed (Microsoft pattern). |
| `phases[]` | Ordered, default names Triage, Investigate, Contain, Eradicate, Recover, Close. |
| `mitre[]` | ATT&CK techniques the runbook covers (used for matching and coverage). |
| `owner`, `reviewers[]` | People or roles. |
| `status` | Draft, In review, Published, Retired. |
| `version`, `created_at`, `updated_at`, `published_by`, `published_at` | Immutable history per version. |
| `review_every_days` | Default 180; "Review due" badge after it lapses. |
| `derived_from` | Set when cloned from a built-in or another runbook (CACAO idea). |
| `references[]` | Links, for example vendor guidance. |

Step fields:

| Field | Notes |
|---|---|
| `id`, `title`, `phase` | Stable id so runs can be compared across versions. |
| `kind` | `check`, `lookup`, `decision`, `action`, `record` (8.2.1). |
| `instructions` | Operator Markdown, short. Questions are encouraged (Elastic style). |
| `escalate_if`, `benign_if` | Optional, for checks and decisions; also guide the investigator. |
| `required` | Must be done or explicitly marked Not applicable with a reason. |
| `evidence` | `none`, `note`, `note_or_attachment`; enforced before Done (TheHive). |
| `owner_role` | Optional role, for example tier 2 or incident lead. |
| `approval_role` | Optional; the step needs a second person in that role to approve the recorded action. |
| `target_minutes` | Optional time target, shown, never enforced. |
| `lookup` | For `lookup` steps only: one read-only tool call template (8.2.2). |
| `options[]` | For `decision` steps: labelled options, each can mark later steps Not applicable. |
| `react`, `d3fend` | Optional RE&CT RA id and D3FEND technique for actions. |

#### 8.2.1 Step kinds

1. **Check**: a person verifies something and records what they found. Example: "Did any
   attempt succeed after the failures?" with escalate if / benign if.
2. **Lookup**: a read-only query the suite runs itself when the run starts, or on a Run
   button: log search with a field filter and window, indicator enrichment, related cases by
   entity, campaign membership, MITRE context. The result is attached to the step as evidence
   labelled "Collected automatically". This is Elastic's investigate button and Splunk ES's
   embedded search, executed by the existing read-only tools.
3. **Decision**: a person picks an option ("Confirmed malicious / Suspicious, unconfirmed /
   Benign"). Options can mark later steps Not applicable. Mirrors XSOAR manual conditional,
   Google yes-no questions and CACAO if/switch.
4. **Action**: a response action a person performs in another system (isolate host, disable
   account, block domain, reset credentials, quarantine mail). The step shows the
   instructions and records who did it, when, where (free text or ticket reference), and the
   outcome. Optional approval by a second role. The suite never executes it. This is CACAO's
   `manual` command and NIST RS.MI-01 R1.
5. **Record**: notify, document or hand off (inform the data owner, open an IT ticket, write
   the after-action note). Recorded like an action.

#### 8.2.2 Lookup templates (read-only, deterministic)

A lookup is declarative, like Elastic's `[[transform.investigate]]`:

```yaml
lookup:
  tool: log_search          # or enrich, related_cases, campaign, mitre
  filter:
    source.ip: "{{entity.ip}}"
    event.outcome: success
  window: case_first_seen-1h..case_last_seen+1h
  limit: 50
```

Rules: only the suite's existing read-only tools are allowed (`es_query` on the read-only
client, cached `enrich`, case and campaign stores); template values come from the case and
are passed as parameters, never concatenated into query text; results are bounded and
aggregated where possible (#7); results are untrusted data everywhere they appear (#9).

### 8.3 Matching and attachment
- **`applies_when`** keeps today's playbook contract (rule ids, entity types, minimum event
  count, MITRE techniques, any tags) and adds severity floor, source or source type, verdict
  (for example only when the verdict is TRUE_POSITIVE or NEEDS_HUMAN), and case status.
  Every criterion is any-of; all present criteria must match (current semantics).
- **Selection:** most specific match wins (rule beats technique beats generic), then priority
  number, then newest version. Ties are reported, not hidden.
- **When it attaches:** when a case first needs a person (status open after investigation,
  NEEDS_HUMAN, escalated, or a human opens it), and again when the case changes (severity
  raised, verdict confirmed). A given runbook attaches to a case at most once (idempotent by
  case id plus runbook id, in the spirit of #4). Auto-closed cases do not get a run, which
  keeps the autopilot path quiet; the investigator still receives the published runbook as
  guidance.
- **Why it attached** is stored and shown: "Matched rule `ssh_auth_failed` and technique
  T1110". Manual attachment shows "Added by Asha".
- **Generic fallback:** an optional built-in "Generic incident (NIST 800-61)" runbook attaches
  when nothing else matches. Default off or on is an operator question (section 9).
- **AI suggestion (optional):** when nothing matches, the case can show "Suggested runbook"
  from a single gateway call with a reason; a person accepts it. Deterministic matching is
  always tried first and costs nothing.
- **Test against recent cases:** in the editor, "Which cases would this match?" runs the
  matcher over recent cases and lists them, without attaching anything and without touching
  metrics (FireHydrant test idea).

### 8.4 Per-case run
- **Data:** run id, case id, runbook id and pinned version snapshot, attached by (rule,
  person, accepted suggestion), attached at, and per step: status (To do, In progress, Done,
  Not applicable, Blocked), assignee, started at, completed at, completed by, note, evidence
  references (lookup result, attachment, link), approval (requested by, approved by, time),
  AI draft (text plus "AI draft" flag until a person confirms).
- **Storage:** reuse the zero-migration KV pattern used by `case_tasks`, one document per case
  run with strict CAS, no new index or table, consistent with how Rounds 3 to 13 added
  stores.
- **Ad-hoc tasks:** keep "Add task" for one-off work and show those tasks in the same
  checklist under "Other tasks", with provenance like Sentinel. The existing `CaseTask` data
  moves under this surface so there is one checklist per case, not two.
- **Where it lives:** a **Runbook** tab in Case detail with a count chip "4/11" (like the
  current "open tasks" chip), a "Next step" line on the Overview tab and in the facts rail,
  and a progress column or chip in the Case Manager queue.
- **Close behaviour:** resolving a case by hand with required steps still open asks for a
  short reason, which is audited. This mirrors CISA's "completed checklist to close" without
  blocking the deterministic policy: `decide()` and auto-close never look at runbook state.
- **Version pinning:** a run keeps the version it started with; if a newer version is
  published, the run shows "A newer version exists" with an explicit "Switch" that carries
  over completed steps by step id.

### 8.5 AI assistance, bounded
| AI does | AI never does |
|---|---|
| Suggests a runbook when nothing matches (gateway call, #6) | Attach a runbook without a person when matching is by suggestion |
| Runs Lookup steps through read-only tools and attaches results | Run anything that changes another system |
| Drafts a note for a Check step from lookup results, marked "AI draft" | Mark a human step Done, Not applicable or Approved |
| Answers "What's next on this case?" and "Summarise runbook progress" in Case chat | Change verdict, status, `AutoClosePolicy` or `decide()` |
| Drafts a new runbook from a human-confirmed closed case, saved as Draft | Publish a runbook |
| Proposes MITRE, RE&CT and D3FEND tags in the editor | Treat its own draft text as trusted guidance |

The investigator receives only **published** runbook text as trusted operator guidance (the
role today's playbooks play), including `escalate_if` and `benign_if`. The run state, notes,
lookup results and every case value are passed as untrusted, fenced data. A step template
like `{{entity.user}}` is filled with untrusted data and fenced, never treated as an
instruction.

### 8.6 Non-negotiables, mapped
| # | How the design keeps it |
|---|---|
| 1 Read-only scoped log key | Lookups use the existing read-only client; no write tool is added. |
| 2 Every action audited | Attach, step status change, note, evidence, approval, skip reason, switch version, publish, retire: each an append-only AuditDoc with actor and time, plus the friendly case activity entry. |
| 3 Deterministic close | Runbooks, steps, decisions and completion never feed `decide()` or `AutoClosePolicy`; matching and the manual-close reason prompt live outside the policy. A runbook can recommend, never decide. |
| 4 No duplicate | One run per case and runbook; re-investigation does not create a second run. |
| 6 One gateway | Runbook suggestion, AI drafts and runbook drafting are gateway calls and ledgered; matching and lookups are $0. |
| 7 Aggregate first | Lookup results are bounded and summarised before any model sees them; metrics are aggregates. |
| 8 Enrichment cached | Enrichment lookups go through the cached `enrich` path. |
| 9 Untrusted data | Imported and AI-drafted runbooks start as Draft and are untrusted until a person publishes them; all case values, lookup results and notes are fenced. |
| 10 Sane defaults | Built-in library on, auto-attach on for human-facing cases, AI suggestion and AI drafts behind settings. |
| 12 Read-only consumer | Containment and eradication are human Action steps; the suite records them, never performs them. |

### 8.7 Authoring and governance
- **Editor layout:** left, an outline of phases and steps (drag to reorder, add step by kind);
  right, the selected step's form; top, header fields and `applies_when` as chips with a
  picker for rules, techniques, severity and entity types; a Preview toggle that shows the
  runbook exactly as an analyst will see it on a case; a Source toggle that shows and accepts
  the Markdown file.
- **States:** Draft, In review, Published, Retired. Publishing needs `runbooks:publish`
  (new permission or a role check); optional "approver must differ from author" setting.
  Retired runbooks stay readable for cases that used them.
- **Built-ins:** read-only, with "Duplicate to customise" (sets `derived_from`); a customised
  copy can replace the built-in for matching.
- **Review cadence:** "Review due" when `last_reviewed` plus `review_every_days` passes; a
  "Mark reviewed" action records reviewer and date.
- **History:** every published version kept; side-by-side diff of steps; restore an old
  version as a new draft.

### 8.8 Built-in library (proposal, about 12, merging today's 18 files)

| Runbook | Merges today | Phases | Key ATT&CK | Example actions (RE&CT / D3FEND) |
|---|---|---|---|---|
| Phishing or reported suspicious email | `mail_abuse`, `phishing_reported_email` | Triage, Investigate, Contain, Recover, Close | T1566 | RA2204, RA3203 Quarantine email, RA4201 Delete email |
| Malware on an endpoint | `malware` | Triage, Investigate, Contain, Eradicate, Recover | T1204, T1059 | Network Isolation, Process Termination, File Eviction |
| Ransomware or destructive activity | `ransomware_response` | Triage, Contain, Eradicate, Recover, Close | T1486, T1490 | RA5002 Restore data from backup |
| Brute force and password spray | `brute_force`, `brute_force_login` | Triage, Investigate, Contain, Close | T1110 | RA3101 Block external IP, Account Locking |
| Compromised account or suspicious sign-in | (new; impossible travel) | Triage, Investigate, Contain, Recover | T1078 | RA4601 Revoke credentials, Reissue Credential |
| Cloud identity and access key compromise | `cloud_iam_compromise`, `cloud_identity_compromise` | Triage, Investigate, Contain, Eradicate, Recover | T1078.004, T1552 | Credential Revocation |
| Data exfiltration | `data_exfiltration`, `data_exfiltration_response` | Triage, Investigate, Contain, Close | T1041, T1567 | Network Isolation, notify data owner |
| Web application attack | `web_attack`, `web_application_abuse` | Triage, Investigate, Contain, Close | T1190 | block source, WAF rule request |
| Scanning and reconnaissance | `port_scan`, `vuln_scan`, `web_scanner_activity` | Triage, Close | T1595, T1046 | often benign; block if repeated |
| Suspicious outbound or known-bad destination | `ip_reputation`, `suspicious_outbound_connection` | Triage, Investigate, Contain | T1071, T1571 | RA3101, DNS sinkhole request |
| Privileged access misuse and insider activity | `privileged_web_access` | Triage, Investigate, Contain, Close | T1078.003 | Account Locking, HR / legal record step |
| Generic incident (NIST 800-61) | (new fallback) | All six | any | declare, scope, preserve, contain, recover, lessons |

Optional later: Denial of service, Vulnerability disclosure (CISA vulnerability playbook),
Cryptomining. Each built-in uses the Elastic-style step shape and today's
TRUE POSITIVE / FALSE POSITIVE / NEEDS HUMAN content as `escalate_if` and `benign_if`.

### 8.9 Import and export
- **Native:** one Markdown file per runbook with front matter for the header and
  `applies_when`, and a structured body (phase headings, step headings with a small key list).
  Dependency-free parsing, like today (`backend/app/engine/runbooks.py`).
- **Export:** Markdown (single or all, zipped through the existing Jobs artifact path) and
  CACAO v2.0 JSON: phases become sequential `action` steps, Check, Action and Record become
  `manual` commands with `agent` of type `group` (the owner role), Decision becomes
  `switch-condition`, Lookup becomes a `manual` command whose text describes the query
  (CACAO has no command type for "read from this product"), `playbook_types` from phases
  (investigation, mitigation, remediation), `created_by`, `created`, `modified`,
  `derived_from` filled.
- **Import:** Markdown and CACAO JSON. CACAO `manual` and condition steps map directly; every
  other command type (bash, ssh, powershell, http-api, openc2-http, and so on) is imported as a
  human Action step with the command shown as plain text and a warning, never executed.
  Imports always land as Draft and are untrusted until published (#9).

### 8.10 Metrics (honest)
On the library page and in Analytics:
- Runs started, completed, abandoned per runbook (last 30 days).
- Median time to complete per runbook, per phase and per step; the slowest steps.
- Most skipped or Not applicable steps (a signal the runbook needs editing).
- Coverage: share of human-handled cases that had a runbook; detection rules and ATT&CK
  techniques seen in the window with no matching runbook.
- Response time for cases with and without a completed runbook, as two cohorts with counts
  and a clear "comparison, not cause" note; insufficient data shows as such, never as a rate.

### 8.11 Migration
- Merge the two bundled sets into the new library (8.8).
- Convert operator-authored runbooks and playbooks into the new format automatically: header
  and match contract carry over, body labels become steps. Whether they land as Published or
  as Draft "Review after migration" is an operator decision (section 9).
- Keep feeding published runbook text to the RAG `runbook` corpus so chat and the
  investigator can cite it.
- Retire the playbook selection path and its trusted injection in favour of the runbook
  matcher; one place decides which procedure guides the investigator.
- Old API routes (`/api/playbooks*`, current `/api/runbooks*` shapes) need a compatibility
  decision: alias to the new routes for one release or return 410 with a pointer, following
  the repo's existing deprecation pattern.

### 8.12 UI options worth prototyping (for the options phase)
- **Option A, Checklist panel (Sentinel-like):** one flat list with a progress bar, rows with
  a circle checkbox, title, "from runbook X" or "added by Y", expand for instructions, lookup
  result and note. Simplest; phases shown only as small labels.
- **Option B, Phased runbook tab (Splunk ES-like):** phase pills across the top with counts
  ("Triage 3/3, Investigate 1/4, Contain 0/2"), the selected phase's steps below, each step
  expanding to Instructions, Evidence (collected automatically), Your note, and Done / Not
  applicable / Blocked. Most structured; best for longer runbooks.
- **Option C, Guided next step (Torq and Copilot-like):** a single "Next step" card with the
  AI's prefilled lookup and draft note, Confirm or Edit, then the next card; the full list
  is one click away. Fastest for tier 1, weakest overview.
- Recommended: B as the tab, with C's "Next step" card pinned at the top of the tab and
  repeated on the case Overview. A is the fallback if B feels heavy at 390 px.

## 9. Open questions for the operator
1. **Auto-attach:** attach the matching runbook to every case that needs a person (proposed),
   or only suggest it and let the analyst start it?
2. **Generic fallback:** should cases with no specific match get the "Generic incident"
   runbook by default?
3. **Closing with open required steps:** ask for a reason (proposed), block human closure, or
   do nothing?
4. **Approvals:** do you want two-person approval for Action steps (for example "disable
   account") and for publishing runbooks, or is a single analyst enough?
5. **Merge Case tasks:** move today's free-form Case tasks into the runbook checklist as
   "Other tasks" (proposed), or keep them separate?
6. **Library scope:** the 12 above, or also DoS, vulnerability disclosure and cryptomining?
7. **Migration:** should your existing operator-written runbooks and playbooks become
   Published straight away, or Draft for review?
8. **AI drafting:** allow "Draft a runbook from this closed case" (ASP-style knowledge
   extraction) in this round, or later?
9. **ASP-style "Run" button:** ASP's "Run Playbook" also launches AI jobs (investigation,
   enrichment, summary). Agentic SOC already has Reinvestigate and enrichment; should those
   appear as Lookup steps inside runbooks, as a separate "Run" menu on the case, or neither?
10. **CACAO:** is CACAO JSON export and import needed now, or is Markdown enough for this
    round?

## 10. Reference screenshots collected (scratchpad, not for commit)
- `<scratch>/r14/notes/rbshots/cur-runbooks.png` (today, Reference runbooks)
- `<scratch>/r14/notes/rbshots/cur-playbooks.png` (today, Response playbooks)
- `<scratch>/r14/notes/rbshots/asp-img.CcLueN_g.png` (ASP playbook run list)
- `<scratch>/r14/notes/rbshots/asp-img_0.B0Y86DL3.png` (ASP case header, Run Playbook entry)
- `<scratch>/r14/notes/rbshots/asp-img_2.DkUYgnyM.png` (ASP run detail)
- `<scratch>/r14/notes/rbshots/asp-playbook-doc.png` (ASP docs page, full)
- `<scratch>/r14/notes/rbshots/sentinel-incident-tasks.png` (Microsoft Sentinel incident tasks panel)

Third-party screenshots are copyrighted by their owners; use them for internal comparison
only and do not commit them to the repository.

## 11. Sources
- ASP: https://asp.viperrtp.com, https://asp.viperrtp.com/llms.txt,
  https://asp.viperrtp.com/asp/workspace/playbook/, https://asp.viperrtp.com/asp/development/playbook.md,
  https://asp.viperrtp.com/asp/workspace/case.md, https://asp.viperrtp.com/asp/workspace/knowledge.md,
  https://asp.viperrtp.com/asp/overview/glossary.md, https://asp.viperrtp.com/release/0_6_0_Winter_is_Coming/,
  https://asp.viperrtp.com/asp/integrations/skills/asp-playbook-creator.md,
  https://github.com/FunnyWolf/agentic-soc-platform
- NIST SP 800-61r3: https://csrc.nist.gov/pubs/sp/800/61/r3/final (PDF https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-61r3.pdf)
- SANS: https://www.sans.org/white-papers/33901/
- CISA: https://www.cisa.gov/sites/default/files/publications/Federal_Government_Cybersecurity_Incident_and_Vulnerability_Response_Playbooks_508C.pdf
- CACAO v2.0: https://docs.oasis-open.org/cacao/security-playbooks/v2.0/security-playbooks-v2.0.html
- RE&CT: https://atc-project.github.io/atc-react/
- D3FEND: https://d3fend.mitre.org/
- Cortex: https://cortex-docs.paloaltonetworks.com/cortex-xsiam-developer-guide/cortex-xsiam-development-guide/playbooks.md,
  https://cortex-docs.paloaltonetworks.com/cortex-xsoar-8-saas/configure-cortex-xsoar/playbooks/develop-your-playbook/task-3.-add-tasks/create-a-conditional-task,
  https://xsoar.pan.dev/docs/playbooks/playbooks-field-reference,
  https://docs-cortex.paloaltonetworks.com/r/Cortex-XSIAM/Cortex-XSIAM-Documentation/Add-a-playbook-trigger-to-an-alert,
  https://cortex-docs.paloaltonetworks.com/cortex-xsoar-8-saas/investigate-and-respond-to-threats/incidents-and-indicators-investigation/investigate-an-incident
- Splunk: https://help.splunk.com/en/splunk-soar/soar-on-premises/administer-soar-on-premises/8.7.0/configure-product-settings-for-your-splunk-soar-on-premises-instance/define-tasks-using-workbooks,
  https://help.splunk.com/en/splunk-soar/soar-on-premises/use-splunk-soar-on-premises/8.7.0/manage-cases-in-splunk-soar-on-premises/define-a-workflow-in-a-case-using-workbooks-in-splunk-soar-on-premises,
  https://help.splunk.com/en/splunk-enterprise-security-8/user-guide/8.7/mission-control/respond-to-investigations-with-response-plans-in-splunk-enterprise-security,
  https://help.splunk.com/en/splunk-enterprise-security-8/administer/8.7/response/included-response-plans-in-splunk-enterprise-security
- Microsoft: https://learn.microsoft.com/en-us/azure/sentinel/incident-tasks,
  https://learn.microsoft.com/en-us/azure/sentinel/automate-incident-handling-with-automation-rules,
  https://learn.microsoft.com/en-us/security/operations/incident-response-playbooks,
  https://techcommunity.microsoft.com/blog/microsoftthreatprotectionblog/-/4416350,
  https://microsoft.github.io/zerotrustassessment/ja/docs/workshop-guidance/securityoperations/SVA_AI006
- Google SecOps: https://docs.cloud.google.com/chronicle/docs/secops/respond-cases,
  https://security.googlecloudcommunity.com/tuesday-s-tip-of-the-week-93/tuesday-s-tip-of-the-week-designing-playbooks-automation-without-chaos-8207
- CrowdStrike: https://www.crowdstrike.com/en-us/blog/new-falcon-fusion-features-refine-workflow-automation/,
  https://developer.crowdstrike.com/ngsiem/fusion-soar/
- Tines: https://community.tines.com/t/how-do-i-build-a-human-in-the-loop-approval-workflow/30, https://tines.com/blog/humans-in-the-loop-of-ai
- Torq: https://kb.torq.io/en/articles/9734818-socrates-transform-case-investigations,
  https://aws.amazon.com/marketplace/reviews/reviews-list/prodview-2c4o6nqsvkxhy?page=8
- Swimlane: https://www.businesswire.com/news/home/20260127331259/en/Swimlane-Unveils-Fleet-of-AI-Agents-and-Agent-Builder-to-Power-the-Security-Workforce
- TheHive: https://docs.strangebee.com/thehive/user-guides/organization/configure-organization/manage-templates/case-templates/about-case-templates/,
  https://docs.strangebee.com/thehive/user-guides/analyst-corner/tasks/change-task-status/
- Elastic: https://www.elastic.co/docs/solutions/security/detect-and-alert/write-investigation-guides,
  https://www.elastic.co/docs/solutions/security/investigate/run-osquery-from-investigation-guides,
  https://github.com/elastic/detection-rules/blob/main/rules/windows/impact_volume_shadow_copy_deletion_or_resized_via_vssadmin.toml
- SRE and incident management: https://sre.google/sre-book/introduction/,
  https://docs.firehydrant.com/docs/runbook-conditions, https://docs.firehydrant.com/docs/runbook-best-practices,
  https://rootly.com/sre/rootly-vs-firehydrant-alert-management-software-comparison
- Terminology: https://docs.rootly.com/glossary/runbook-vs-playbook,
  https://www.sumologic.com/blog/the-difference-between-playbooks-and-runbooks-in-incident-response/,
  https://www.techtarget.com/it-infrastructure/tip/Compare-runbooks-vs-playbooks-for-IT-process-documentation,
  https://www.cortex.io/post/runbooks-vs-playbooks
- Libraries: https://github.com/aws-samples/aws-incident-response-playbooks

## Journal entry (for the orchestrator to append)

### 2026-10-25 15:30Z, research sub-agent (runbooks-industry), Round 14 Ask 9 runbook research
- Context: operator asked to merge playbooks and runbooks into one rebuilt Runbooks feature per industry practice, referencing asp.viperrtp.com.
- Did: studied ASP, NIST SP 800-61r3, SANS, CISA playbooks, CACAO v2.0, RE&CT, D3FEND, Cortex XSOAR/XSIAM, Splunk SOAR and ES, Microsoft Sentinel and Defender, Google SecOps, Falcon Fusion, Tines, Torq, Swimlane, TheHive, Elastic investigation guides, FireHydrant, Google SRE, AWS libraries; captured today's two pages and reference screenshots; wrote docs/research/2026-10-round14/research/runbooks-industry.md with a recommendation (one Runbooks feature, five step kinds, deterministic matching, per-case pinned run, bounded AI help, governance, library of about 12, Markdown plus CACAO export).
- Tests: none (research only).
- Status: done.
- Next: operator answers the open questions in section 9; options phase prototypes UI options A, B, C from section 8.12.
