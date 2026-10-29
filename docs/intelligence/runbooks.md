---
title: Runbooks
description: Write, review and publish your team's response procedures, and work through them on a case.
---

# Runbooks

Runbooks are your team's step-by-step response procedures. The matching runbook is
attached to each case that needs a person. Analysts work through it as a checklist; the AI
runs the read-only lookups and can draft notes. A runbook never closes a case; your case
policy does that.

Open **Intelligence → Runbooks** to see the library. Every runbook is used in three places:

- **The library and the editor**, where your team writes, reviews and publishes runbooks.
- **The case**, where the matching runbook appears on the Runbook tab of Case detail and
  Case Manager, with a Next step card on the Overview tab.
- **The investigator**, which reads the published runbook that matches a cluster as
  trusted guidance before it investigates, and the knowledge search, which indexes
  published runbooks.

The library lists every runbook with where it came from (Built-in, Yours or Imported), the
rules and techniques it applies to, its state, its phases and steps, its runs in the last 30
days and when its review is due. The figures above the list count runs, completed runs and
cases with a runbook from your cases, so they need `cases:read`; without it they say so and
the rest of the page works. A figure that is still loading or could not be read says so
rather than showing a number, and when a month of runs is too large to count in full the run
figures read "at least".

Reading runbooks needs `runbooks:read`. Writing, sending for review, retiring and
restoring a version as a draft need `runbooks:manage`. Publishing, sending a version back
to draft, restoring a retired runbook and marking a runbook reviewed need
`runbooks:publish`. Working through a runbook on a case needs `runbooks:run`.

## Phases and steps

A runbook is an ordered set of phases, each holding one or more steps. The phases are a
fixed vocabulary that follows NIST SP 800-61r3 and SANS PICERL; most runbooks use three or
four of them.

| Phase | NIST SP 800-61r3 | SANS |
|---|---|---|
| Triage | DE.AE, RS.MA | Identification |
| Investigate | RS.AN | Identification |
| Contain | RS.MI-01 | Containment |
| Eradicate | RS.MI-02 | Eradication |
| Recover | RC.RP | Recovery |
| Close and learn | RC.CO, ID.IM | Lessons learned |

Every step is one of five kinds:

| Kind | Who does it | What the case keeps |
|---|---|---|
| Check | A person verifies something, written as the question it answers | Status, a note and an optional link; "Escalate if" and "Benign if" are shown as a pair |
| Lookup | The suite runs a read-only query | The result, labelled "Collected automatically", with its parameters and when it ran |
| Decision | A person picks one of two to six options | The option, who and when; an option can mark later steps Not applicable |
| Action | A person acts in another system | Who, when, where and the outcome; Agentic SOC does not run the action |
| Record | A person notifies, documents or hands off | As for an action; Agentic SOC does not send anything |

A step is required unless it is marked optional. Closing a case by hand with a required
step still open asks for a reason; it never blocks the close. Automatic closes never look
at runbook steps, and recording a decision never changes the verdict.

Each step can also name who does it, who approves it (Action and Record steps, honoured only
when step approvals are on in Settings), the evidence it needs before Done, a target time
that is shown and never enforced, and RE&CT and D3FEND ids.

## Which runbook a case gets

**Applies when** lists the conditions a runbook needs. Each condition matches any of its
values, and a runbook needs every condition it lists:

- rules (exact rule values) and ATT&CK techniques (a parent technique matches its
  sub-techniques);
- entity types, sources (a source id or `type:<source type>`), a minimum severity and a
  minimum number of events;
- verdicts, case statuses and tags; and
- the fallback, which matches any case and is used only when nothing else matches. The
  built-in Generic incident runbook is the fallback.

When several runbooks match, the most specific wins: a rule match first, then a technique
match, then the other conditions, then the fallback. Ties go to the higher priority, then the
runbook that matched the most conditions, then the newest published, then the id in
alphabetical order. The case's Runbook tab says why a runbook was attached ("Matched rule
ssh_auth_failed and technique T1110").

Matching happens twice. Before the investigation, a cluster has no verdict, status, tags and
often no techniques yet. A condition whose fact is not known yet is tolerated only behind a
rule match, so a runbook that names its rules still guides the investigator; without a rule
match, an unknown fact blocks the match. When the case needs a person, every fact is known
and every condition the runbook lists must match.

Tags carried over from an earlier version of a runbook (its tags and keywords) are
conditions like any other: the case must carry the tag. Every converted runbook that gained
one carries an import note saying so.

Matching is free: no model is called. A runbook attaches to a case at most once; a later
change to the case attaches another runbook only when it matches more specifically than every
runbook already on the case, and it never removes one.

## Writing a runbook

Choose **New runbook**, or **Create a runbook** beside a rule in **Rules with no runbook**,
which starts with that rule in Applies when. The editor has three views of the same runbook:

- **Edit** shows an outline of phases and steps beside the selected step's form. Add a step
  by kind from **Add step**, add a phase from **Add phase**, and move a step by dragging it or
  with Alt and the arrow keys. **Runbook details** at the top of the outline holds the title,
  summary, use when, prerequisites, priority, owner, review cadence, the techniques the
  runbook covers, search phrases and references (https links only).
- **Preview as analyst** shows the Runbook tab as an analyst will see it before anyone
  starts. **Fill with** a recent matching case resolves the lookup values from that case, and
  the meter shows the investigator guidance against its budget, for example "Investigator
  guidance: 2,140 of 3,000 characters".
- **Source** shows the Markdown. Chips and front matter are the same fields; edit either, and
  the outline follows as you type.

The editor checks the runbook as you work and lists each problem beside its field and in a
summary under the outline; each entry in the summary moves to its field. A problem you fix
goes away at once. A new runbook shows a problem only once you leave its field or try to
save, and its summary once you try to save; a save the server refuses lists every problem
and moves focus to the summary. Publish stays unavailable while problems remain and says how
many ("Fix 2 problems to publish"). A new runbook's id must not be taken: the Id field says
so, and the rest of what you wrote is kept.

Nothing you type is lost to a save that is still running: an edit made meanwhile stays, and
the page shows it as unsaved. This holds for the first save of a new runbook too: its own page
opens with what you typed meanwhile as unsaved changes. While you have unsaved changes, the
actions that would replace them (Mark reviewed, Retire, Send back to draft and restoring a
version) wait until you save or discard. Changing a step's kind keeps what you wrote for the
old kind, such as Escalate if or the decision options, and brings it back if you switch back;
a field you cleared stays cleared, and removing the step, **Reload** or discarding the draft
lets go of anything kept this way. If the Markdown in **Source**
has a problem when you switch to another view, the editor asks first, because the outline
keeps only the last version that read correctly.

**Which cases would this match?** tests the runbook you are editing against the last 500
cases of the last 30 days: the cases that would get it, the cases where another runbook wins
(named), and the near misses with the condition that failed. Nothing is attached and no
metric changes. It needs `cases:read`.

A Lookup step's **Test with a case** runs the lookup once against a case you choose, without
saving anything. It needs `runbooks:manage`, `sources:read`, `cases:read` and the lookup's own
grant.

If someone else saves the draft while you edit it, saving says "Someone else changed this
draft. Reload it to see their changes." Your edit stays in the Source view until you reload,
so you can copy it.

## Lookups

A Lookup step runs one read-only query with values from the case. Case values are passed as
parameters, never written into query text, and results are untrusted data shown as plain
text.

| Tool | Reads | Needs |
|---|---|---|
| Log counts (`log_stats`) | counts and top values in the case's sources, at most 50 keys | `sources:read` |
| Log search (`log_search`) | matching log rows, at most 20, shown to people only | `sources:read` |
| Indicator reputation (`enrich`) | the reputation of one case value, through the cached enrichment path | `enrichment:read` |
| Related cases (`related_cases`) | cases that share the entity or rule, at most 10 | `cases:read` |
| Campaign membership (`campaign`) | the campaign the case belongs to | `cases:read` |
| ATT&CK context (`mitre`) | the bundled technique reference | `runbooks:read` |

A viewer without a lookup's grant sees the step and its status but not the result.

**Case values** are written in double braces: `{{case.rule}}`, `{{case.source_id}}`,
`{{case.first_seen}}`, `{{case.last_seen}}`, `{{entity.ip}}`, `{{entity.user}}`,
`{{entity.host}}`, `{{entity.domain}}`, `{{entity.hash}}`, `{{entity.url}}` and
`{{entity.email}}`. A case without the value reads "This case has no source IP" (or the value
named) instead of running.

**Filter fields** for the log tools:

- `ip`, `user`, `host`, `rule`, `rule_name` and `severity` are logical names. Each means the
  source's own mapped field, so one runbook works on every source.
- `action` is the ECS field `event.action` on every source (it is empty where a source does
  not record it).
- Any other name is read as a log field path exactly as written, such as `event.outcome`,
  `destination.ip` or `url.domain`.

**Values**: `ip`, `user`, `host` and `rule` take their own case value (`ip` takes
`{{entity.ip}}`, `rule` takes `{{case.rule}}`) or a literal of the same kind, such as an IP
address for `ip`. `rule_name`, `severity` and `action` take a literal only. A physical path
takes a literal or any case value.

**Window**: by default an hour either side of the case
(`case_first_seen-1h..case_last_seen+1h`); you can also give `now-24h`, `now-7d`, `today`,
`yesterday`, `this_week`, `last_week` or your own range. A window spans at most 30 days and
never reaches past the moment the lookup runs.

**When it runs**: "When the runbook starts" runs it in the background, at no cost, as soon
as the runbook attaches; "When the analyst presses Run" waits for an analyst.

## Review and publishing

A runbook moves through four states: **Draft**, **In review**, **Published** and **Retired**.

- Editing a published runbook creates a draft; the published version stays live until the
  draft is published. Cases already working through a version keep that version, and the
  editor says how many ("3 open cases stay on v4").
- **Send for review** asks someone with `runbooks:publish` to look at it. They can publish it
  or send it back to draft with a reason. A publisher may also publish a draft directly.
- **Publish** makes that exact version live: it is bound to the version and its contents as
  you reviewed them, so a change made in the meantime is refused and you reload first.
- When separate approval is on in the Runbooks settings (`runbooks.require_distinct_approver`),
  nobody who wrote or edited a version can publish it; another person with publish rights
  must.
- **Retire** stops a runbook matching new cases. Runs that used it keep working and stay
  readable. A draft that was never published can be discarded; published history is never
  deleted.
- Each runbook has a review cadence (180 days by default). The library shows when a review
  is due, and **Mark reviewed** records the review without making a new version.

**History** lists every version with who published it, compares any two versions step by
step (steps added, removed, moved or edited, and which fields changed), and restores an old
version as a new draft. Restore waits while a draft or a version in review exists (discard or
publish it first) and while the editor holds unsaved changes.

Only a published version guides the investigator or enters the knowledge search. A draft,
a version in review and anything the AI writes never do.

## The built-in library

Twelve runbooks ship with Agentic SOC and are updated with its releases: phishing, malware
on an endpoint, ransomware, brute force and password spray, compromised account, cloud
identity and access keys, data exfiltration, web application attack, scanning and
reconnaissance, suspicious outbound traffic, privileged misuse and insider activity, and the
Generic incident fallback.

Built-ins are read only. **Duplicate to customise** makes a copy you own as a draft; once your
copy is published it replaces the built-in for matching, and the built-in is listed under
**Show replaced built-ins**. A case-automation rule that names the built-in still attaches it.
In Demo Mode the editor's write actions are shown disabled, with "Runbooks cannot be edited
in Demo Mode." beside them.

## The Markdown format

Every runbook has one Markdown file: front matter, then a heading per phase, then a heading
per step with its attributes and key lines. **Export as Markdown** writes exactly this form;
**Import Markdown** reads it and always creates a draft.

````markdown
---
id: brute-force-password-spray
title: Brute force and password spray
summary: Many failed sign-ins against one or more accounts, from one or many sources.
use_when: A detection reports repeated failed authentication against our accounts.
version: 4
priority: 60
owner: soc-leads
review_every_days: 180
mitre: [T1110, T1110.003]
applies_when:
  rule_ids: [ssh_auth_failed, win_logon_failure_burst]
  mitre: [T1110]
  entity_types: [ip, user]
references:
  - https://attack.mitre.org/techniques/T1110/
---

## Triage

### Is the source internal or external? {#source-scope kind=check}
Focus: source IP, its network zone and the asset inventory.
Escalate if: the source is an internal host that is not an approved scanner.
Benign if: the source is an approved vulnerability scanner or a known test.

Look the source up in the asset inventory before anything else.

### How many accounts were tried? {#accounts-tried kind=lookup}
```lookup
tool: log_stats
filter:
  source.ip: "{{entity.ip}}"
  event.outcome: failure
group_by: [user.name]
window: case_first_seen-1h..case_last_seen+1h
limit: 20
run: on_attach
```

## Investigate

### Is this a confirmed compromise? {#decide kind=decision}
Options:
- confirmed: Confirmed compromise
- suspicious: Suspicious, unconfirmed
- benign: Benign | skips: block-source, reset-credentials

## Contain

### Block the source at the edge {#block-source kind=action optional react=RA3101 d3fend=D3-NI}
Record where you blocked it (firewall, WAF or ticket number).
````

- A step heading carries `#<step id>` and `kind=` (both required), and optionally `optional`,
  `owner=<role>`, `approval=<role>`, `evidence=note` or `evidence=note_or_attachment`,
  `target=<n>m` or `target=<n>h`, `react=` and `d3fend=`.
- `Focus:`, `Escalate if:`, `Benign if:` and `Options:` are key lines at the start of a step.
  The rest is instructions for people: paragraphs, lists, bold, italics, inline code and https
  links. Instructions are never part of the investigator's guidance.
- A Lookup step holds its query in a fenced `lookup` block.
- `version` is written on export and ignored on import. An unknown key is reported as a
  problem, never dropped silently. A file is at most 64 KiB.

The investigator reads the title, summary and use when, then the kind, title, focus, escalate
and benign lines of each Triage and Investigate step, then the step titles of the later phases.
That guidance must fit in 3,000 characters; a version over the budget cannot be published.

## Coming from an earlier version

Earlier versions kept two separate lists, "Reference runbooks" and "Response playbooks". On
upgrade, each stored document of either kind became one runbook: a document whose guidance
fits the new rules is published and due for review, and one that needs changes is a draft
with its problems listed. The library shows a one-time note with the counts and a
**Show imported** filter. The investigator now reads each step's title and focus line, so
check each imported runbook. A case-automation rule that named an earlier procedure attaches
the runbook it became; see [Detection and rules](../automation/rules.md).

## Related pages

- [Case Manager](../analyst/case-manager.md), where analysts work through a runbook.
- [Detection and rules](../automation/rules.md), for attaching a runbook from a rule.
- [Knowledge and memory](knowledge-memory.md), for the knowledge search and operator memory.
- [Permissions](../reference/permissions.md), for the runbook grants.
