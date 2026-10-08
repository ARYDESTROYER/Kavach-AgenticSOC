---
title: Workspace Chat
description: Ask read-only questions about your data or this console, watch every lookup as it runs, read answers with charts and citations, track tokens and cost, and collect results into reports.
---

# Workspace Chat

Open **Triage → Workspace → Chat** to ask questions about your security data or about
Agentic SOC itself. For one question the assistant can run several read-only lookups,
such as a log search, a case count, or a metrics query. It then writes an answer
with charts, tables, and citations built from those results. Every lookup, token, and
dollar is shown as it happens.

Chat is **read-only**. It can search and summarize, but it cannot close a case, approve
a proposal, change a setting, or write to a connected source. When a question needs a
change, the answer links the console page where you make it. Answers can be wrong, and
log content is untrusted data, so open the evidence before you act.

## The three zones

The Chat page has three zones:

- **History rail** on the left: your saved conversations, search, and **New chat**.
  When the window is narrow it shrinks to an icon strip, then opens as a side sheet.
- **Conversation** in the middle: the thread toolbar, the transcript, and the composer.
- **Report panel** on the right, on demand: the report you are building from this
  conversation. It opens beside the conversation when there is room and over it
  otherwise.

The thread toolbar shows the conversation title (select it to rename), the
conversation's total tokens and cost, a **Report** toggle with its item count, and a
menu with Rename, Pin conversation, Export conversation, and Delete.

## Ask a question

Type into the composer and press **Enter**; **Shift+Enter** adds a new line. A new
conversation starts with a grid of starters such as *Investigate*, *Hunt an indicator*,
*Posture now*, *Shift brief*, *Explain a metric*, and *Learn the app*. A starter only
appears when you hold the permissions its lookups need.

The composer's control row narrows the question:

- **Read-only** chip: opens **What can the assistant access?**, which lists every lookup
  with its data source, the permission it needs, and whether you have it.
- **Scope** chip: the log source and the time range, for example "Wazuh · 24h". The time
  range applies to every windowed lookup, and the answer states the window it used.
- **@ scopes**: type `@` to limit lookups to `logs`, `cases`, `metrics`, `intel`,
  `docs`, or `platform`. Scopes you lack the permission for are shown disabled.
- **/ commands**: type `/` for `/shift-brief`, `/report <template>`, `/posture`,
  `/hunt <indicator>`, `/case <id>`, `/cost`, `/sources`, `/help <topic>`, and your
  saved prompts. Only commands whose lookups you may run are listed.
- **Options** (`⋯`): the model, the **Type out answers** switch, saved prompts, and the
  keyboard shortcut sheet. A non-default model appears as a removable chip.

Source selection is strict. When you select a source, chat uses that source or reports
that it is unavailable; it never silently falls back to another one. Each saved answer
records the source and model that actually served it.

## Live steps and Type out answers

Chat has two live modes, switched with **Options → Type out answers**:

- **Live steps** (default): every lookup appears as it runs, and the token and cost
  counter updates after every model call. The written answer arrives whole.
- **Type out answers**: the same, plus the final answer appears word by word.

The choice is yours, is remembered for your account, and takes effect from the next
question. Each answer records the mode it ran with. If an administrator has turned off
typed-out answers, or the selected model cannot stream, the switch is disabled and says
why. Steps and token counts are always live in both modes.

## The run log

While the assistant works, a run log sits under your question. Its header shows the
running totals, for example "Working · 3 lookups · 1.2k tokens · $0.002". It has one
row per lookup, or per group of lookups that ran in parallel. A row shows:

- its status: Done, Failed, Timed out, Denied, Skipped, or Stopped;
- what it did, such as "Searched logs" or "Counted cases";
- chips for the effective parameters, including the time window and source;
- a short result summary with row counts, the basis (exact, newest N, sample, or
  cached), and coverage such as "newest 200 of 1,284,113" or "3 of 4 sources
  answered"; and
- the exact query, which you can expand. It is shown as untrusted code.

The final model call appears as one "Writing the answer" row. When the answer starts,
the run log collapses into the answer's meta row, and you can reopen it there.

## Read an answer

A finished answer reads from top to bottom:

1. **The answer**: the direct answer first, then the evidence, in plain formatted text.
2. **Blocks**: charts, tables, and other results (see below).
3. **The meta row**: one line such as "▸ 4 lookups · 6.2 s · 2.1k tokens · $0.004".
   Select the disclosure to reopen the run log, or the token figure for the usage
   details. **Sources** lists the answer's citations and console links. **Copy**,
   **Add to report**, and **Ask again** sit at the right.
4. **Follow-ups**: up to three suggested next questions, on the latest answer only.

Answers about the product carry a **Product help** label. An answer saved before usage
was recorded shows "Usage not recorded · —" instead of a zero. In Demo Mode, money
figures are marked "simulated".

A notice at the top of an answer explains anything unusual: a partial answer, a denied
or timed-out lookup, an unavailable model, a stopped turn, or a question chat cannot
answer from its data. **Retry** appears only when retrying can help.

## Charts, tables, and other blocks

Numbers in blocks come only from lookups. The model chooses which result to show and
how, but it never writes the numbers, so a chart is always backed by a lookup in the run
log. Each block shows its title, a caption with the window and source, and a provenance
tag: **source** for values read from a connected system, **code** for values the
platform computed.

Block types include key-figure groups (a gauge for the Active Risk Index), bar,
horizontal bar, stacked bar, line, area, donut, sparkline, and funnel charts, heatmaps,
tables, case lists, timelines, entity cards, ATT&CK technique cards, query blocks, and
guides with console links. A **Brief** groups several results into a short report with
sections, for example for a shift handoff.

Every block has **Add to report** and a menu with Expand, Show as another view (for
example a bar chart as a donut or a table), Show table, Copy data, Download CSV or
JSON, Copy query, and **Open in Logs** or **Open in Cases** when an exact filter
exists. A table shows ten rows inline; **View all** opens the rest. When a block shows
the top N of a larger total, its caption says so.

You can also ask for a different view in words, such as "show that as a donut" or "now
by host", and the assistant reuses the earlier lookup or its stored result.

## Sources, citations, and console links

**Sources** under an answer lists what it relied on:

- **Help Center citations** (`D1`, `D2`, …) link to the matching page and section of the
  Help Center that matches your installed version.
- **Case and ATT&CK citations** open the case or the technique. **Knowledge
  citations** show the retrieved excerpt as untrusted text and never link.
- **Console links** open the page or Settings section the answer refers to, such as
  **Settings → Security & access → Users**. When you lack the permission for a
  destination, it is shown as plain text with the permission it needs.

The assistant can only cite and link destinations the server recognizes; it never
writes its own URLs.

## Token and cost meter

Chat shows token use and cost before, during, and after each question:

- **Before you send**: the composer shows an estimate such as `≈ 1.2k` tokens for the
  next request (system instructions, the conversation history that will be sent, and
  your draft). Hover for the breakdown, the most the whole question could use, the
  model's context window, the per-question limit, and this conversation's totals. A
  ring beside the estimate shows today's AI spend against the daily budget, when a
  budget is set.
- **While it runs**: the run-log header updates after every model call.
- **After it finishes**: the meta row shows exact totals. Hover the token figure for
  input, cached, output, and embedding tokens, cost, latency, model, the sources
  queried, and whether any value was estimated (`≈`).
- **For the conversation**: the toolbar shows the running total.

Chat shares the AI budget with automatic investigations. When the budget is close, an
alert appears above the composer; when it is reached and the budget blocks spending,
**Send** is disabled and new investigations route to a human. Money and budget figures
need the `models:read` permission, and today's spend also needs `cost:view`; without
them the meter shows tokens only.

## Stop, retry, and continue

While an answer is being written, **Send** becomes **Stop** (or press **Esc** in the
composer). Stopping is handled by the server: the model call already in progress
finishes and is recorded, no new lookup starts, and the answer is saved as **Stopped**
with whatever was completed.

- **Retry same request** repeats a failed request without billing it twice.
- **Ask again** sends the same question as a new request.
- When an answer stops at the lookup or token limit, a **Continue where this stopped**
  chip shows the estimated extra tokens and picks up from there.

If the connection drops, chat checks whether the answer was saved and shows it when it
was. Closing the tab does not stop a question; the answer is saved and appears when you
return.

## Reports

Collect results into a report as you work:

- Select **Add to report** on a block to add that block, or on the meta row to add the
  whole answer as a section. The first add creates this conversation's draft report.
  Select it again to remove it.
- The **Report panel** shows the report title, template (investigation, hunt, IOC,
  shift, posture, or custom), and item count. Each item can carry a note, which saves
  automatically. Move items up or down, or remove them.
- **Generate summary** writes an AI executive summary and up to five next steps. It is
  one metered model call; the button shows the estimated tokens and cost first. The
  summary is labelled "AI-written" and shows **Out of date — Regenerate** after the
  report changes.
- **Export** produces Markdown, HTML, or Print/PDF for the whole report, and CSV or JSON
  for single blocks. Exports include a methodology section listing the lookups, queries,
  samples, and limits behind the numbers. Indicators are defanged by default in
  Markdown, HTML, and print exports.

Open **Triage → Workspace → Reports** for the Reports library: search, open, rename,
delete, and export every report, and jump back to the source conversation. A report
holds up to 40 items, and you can keep up to 100 reports. Reports are never removed
automatically and survive the deletion of their conversation. Content from case-scoped
chat cannot be added to a report.

## Conversation history

**New chat** starts an unsaved draft. It enters history after the first answer is
saved. The rail groups conversations into Pinned, Today, Yesterday, Previous 7 days,
Previous 30 days, and then by month. **Search** looks through titles, questions, answer
text, and block titles, and opens the matching message.

Each row's menu offers Rename, Pin or Unpin, Open report (when the conversation has
one), Export, and Delete. Deleting a conversation keeps its report in the Reports
library. Unsent text is kept per conversation in this browser until you send it.

History keeps up to **50 conversations** per user and **100 messages** per
conversation; up to ten pinned conversations are exempt from the 50-conversation limit.
To stay within the storage limit, the oldest answers' charts and tables are replaced by
"Expired from saved history" placeholders before any older question or answer text is
removed. Saved history is a navigation aid, not the audit or cost ledger; use **Platform
→ Audit log** and **Analytics → Cost** for governed records.

## What chat can read

Each lookup needs the same permission as the console page that shows the same data:

| Scope | Lookups |
| --- | --- |
| `logs` | Search logs (one source or every browsable source) and log statistics such as top values and counts over time |
| `cases` | Search cases, read a case, explain a case decision, the shift report, and campaigns |
| `metrics` | Posture, trends, the noise funnel, case mix, timing, ATT&CK coverage, auto-close health, and agent improvement |
| `intel` | Indicator reputation from your enrichment providers, ATT&CK techniques, and the knowledge corpus |
| `platform` | AI cost and usage, source health, automation status, and the audit log |
| `docs` | The bundled Help Center and the status of this deployment |

Chat cannot read users, roles, sessions, jobs, notifications, dashboards, or secrets,
and it cannot change anything. For those, it answers from the Help Center and links the
console page. Logs reach the model only as aggregates and small samples, never as raw
records. An indicator is sent to an enrichment provider only when it appears in your
own question or in this answer's lookup results, and private addresses and internal
domains are never sent.

When the assistant suggests remembering a fact, the suggestion appears under the answer.
Nothing is stored until a user with the `memory:manage` permission confirms it.

## Ask about the product

Ask how the console works, for example "How do I add a model?", "What does MTTA mean?",
or "Where do I configure SSO?". Product answers come from the Help Center bundled with
this release, cite the exact section, and link the console page. The **Ask about this**
action on a KPI or a Settings section opens a new chat with a prepared question about
it; see the [KPI glossary](kpi-glossary.md).

Product help also works when no AI model is available, for example before a model is
configured, when the budget is reached, or when the provider is failing. Chat then
answers at no cost with the most relevant Help Center excerpt and its links, and a
notice says why the AI was not used.

## Case-scoped chat

The **Chat** tab in Case Manager uses the same assistant with the selected case as its
context. It is compact: there is no history rail, no report panel, and no **Add to
report**. Only the final answer is saved to the case thread, and only when you hold the
`cases:comment` permission; otherwise the answer says "Not saved to the case thread".
Case conversations never enter your personal Workspace history.

| Surface | Use it for | History boundary |
| --- | --- | --- |
| **Workspace → Chat** | Questions across telemetry, cases, metrics, intelligence, and the product | Personal saved conversations and reports |
| **Case Manager → Chat** | Evidence and follow-up tied to the selected case | The case thread; never copied into personal history |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| Esc | Stop a running answer (focus in the composer, no menu open) |
| Ctrl/Cmd+Shift+O | New chat |
| Ctrl/Cmd+Shift+S | Show or hide the history rail |
| Shift+Esc | Focus the composer |
| ↑ in an empty composer | Edit your last question |
| Ctrl/Cmd+/ | Show all shortcuts |

The command palette also offers **New chat**, **Search chats**, **Ask AI**, and
**Open Reports**.

## Limits

Each question is bounded so cost and time stay predictable. By default a question can
use up to 5 model calls and 10 lookups (4 at a time), about 60,000 tokens, and 90
seconds. Each user can run 2 questions at once. An administrator with `settings:manage`
can change these bounds in the `chat_agent` settings group under
**Settings → Organization → All settings**. When a bound is reached, the answer says so
and offers to continue.

Use [Investigation](investigation.md) for the broader entity and case workflow,
[Logs and search](logs-search.md) to inspect telemetry directly, and
[Case Manager](case-manager.md) for actions on a selected case.
