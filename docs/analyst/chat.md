---
title: Workspace Chat
description: Ask read-only questions about your security data or this console, watch every lookup as it runs, read answers with charts and citations, track tokens and cost, and collect results into reports.
---

# Workspace Chat

Open **Triage → Workspace → Chat** to ask questions about your security data or about
Agentic SOC itself. For one question the assistant can run several read-only lookups,
such as a log search, a case count, or a metrics query, and then writes an answer with
charts, tables, and citations built from those results. Every lookup, token, and dollar
is shown as it happens.

Chat is **read-only**. It can search and summarize, but it cannot close a case, approve
a proposal, change a setting, or write to a connected source. When a question needs a
change, the answer links the console page where you make it. Answers can be wrong, and
log content is untrusted data, so open the evidence before you act.

## The page

The Chat page has three zones:

- **History** on the left: **New chat**, search, and your saved conversations. When the
  window is narrow it shrinks to an icon strip, and on a small screen it opens as a
  side sheet from the **History** button.
- **Conversation** in the middle: the thread toolbar, the transcript, and the composer.
- **Report** on the right, on demand: the report you are building from this
  conversation. It opens beside the conversation when there is room and over it
  otherwise. See [Reports](#reports).

The thread toolbar shows the conversation title (select it to rename), the
conversation's total tokens and cost, a **Report** toggle with its item count, and a
`⋯` menu with Rename, Pin conversation, Export conversation, and Delete.

## Ask a question

Type into the composer and press **Enter**; **Shift+Enter** adds a new line. A new
conversation opens with six starters: *Investigate*, *Hunt an indicator*, *Posture
now*, *Shift brief*, *Explain a metric*, and *Learn the app*. A starter appears only
when you hold the permissions its lookups need, and its question is built from your
own data, such as your newest open case or your primary source.

The composer has one row of controls under the text box:

| Control | What it does |
|---|---|
| **Read-only** | Opens **What the assistant can access**: every lookup, its data source, the permission it needs, and whether you have it. A lookup an administrator switched off reads "Turned off on this deployment". |
| Scope | The log source and time range in one chip, for example "Wazuh · 24h". Lookups cover the last 24 hours unless your question names another window. A range you choose here is an outer limit: a question can narrow it but never widen it, and the run log shows the window each lookup used. Reopening a saved conversation restores its time range; the source starts at **All sources**. |
| `@` scopes | Type `@` to limit lookups to `logs`, `cases`, `metrics`, `intel`, `docs`, or `platform`. A scope you lack the permission for is shown disabled with the permission it needs. |
| `/` commands | Type `/` at the start for the commands below and your saved prompts. |
| `≈ 1.2k` | The token estimate for your next request, with today's budget ring (see [Tokens and cost](#tokens-and-cost)). |
| Options `⋯` | Model, **Type out answers**, Saved prompts, and Keyboard shortcuts. A non-default model also shows as a removable chip. A reopened conversation starts on the default model; each saved answer still names the model it used. |
| Send / Stop | Send becomes Stop while an answer is being written. |

On a narrow composer, the scope chips merge into one **Scope · n** chip, the
**Read-only** chip shows only its lock, and the model chip shows only its icon.

### Commands

| Command | Asks |
|---|---|
| `/shift-brief` | A shift handoff: summary, open work, key metrics, and next steps |
| `/posture` | How the SOC is doing right now, with trends |
| `/cost` | AI spend and tokens by role and model |
| `/sources` | Which log sources are silent or degraded, and coverage |
| `/hunt <indicator>` | What is known about an IP, domain, hash, or URL across logs, cases, and threat intel |
| `/case <id>` | What happened in a case, its evidence, and why it was decided that way |
| `/help <topic>` | How a part of this console works |
| `/report <template>` | Start a brief from a template: shift, posture, investigation, hunt, IOC, or custom |

A command is listed only when you may run its lookups. Commands without a value send at
once. A command that takes a value fills the composer and selects the placeholder so you
can type the value and press Enter: the value is then your own words, which matters for
indicator lookups (see [What chat can read](#what-chat-can-read)). In the `/` and `@`
menus, **Enter** chooses an item; **Tab** moves focus and never sends.

### Saved prompts

Keep questions you ask often. Select **Save prompt** beside any of your earlier
questions, or choose **Save current prompt** in the Saved prompts submenu of Options for
the text in the composer. Saved prompts appear in the `/` menu and in that submenu,
where **Manage saved prompts…** lets you use or delete them. You can keep up to 50; they
belong to your account.

### Source and model

Source selection is strict. When you select a source, chat uses that source or says it
is unavailable; it never silently falls back to another one. Each saved answer records
the source and model that actually served it, so changing the controls later never
rewrites an earlier answer. Choosing a model other than the default needs the
`models:read` permission.

### Live steps and Type out answers

Chat has two live modes, switched with **Type out answers** in the composer's Options
menu:

- **Live steps** (the default): every lookup appears as it runs, and the token and cost
  counter updates after every model call. The written answer arrives whole.
- **Type out answers**: the same, plus the final answer appears word by word.

Your choice is remembered for your account and takes effect from the next question.
Each answer records the mode it ran with. When an administrator has turned typed-out
answers off, or the selected model cannot stream, the switch is disabled and says why.

## Follow an answer as it runs

While the assistant works, a run log sits under your question. Its header shows the
running totals, for example "Working · 3 lookups · 1.2k tokens · $0.002". It has one
row per lookup, or per group of lookups that ran side by side. A row shows:

- its status: Done, Failed, Timed out, Denied, Skipped, or Stopped;
- what it did, such as "Searched logs" or "Counted log events";
- chips for the effective parameters, including the time window and source;
- a short result with row counts, the basis (exact, newest N, sample, or cached), and
  coverage such as "newest 200 of 1,284,113" or "3 of 4 sources answered"; and
- the exact query behind a disclosure, shown as untrusted code.

Model calls add no rows of their own; their tokens tick on the header. While the
assistant waits on the model, one row shows **Thinking**, or **Writing the answer** when
a limit has told it to finish. When the answer is done, the last model call stays as one
**Wrote the answer** row, and a model call that failed or timed out keeps its row. When
the answer starts, the run log folds into the answer's meta row, where you can reopen
it.

## Read an answer

A finished answer reads from top to bottom:

1. **The answer**: the direct answer first, then the evidence.
2. **Blocks**: charts, tables, and other results (see below).
3. **The meta row**: one line such as "4 lookups · 6.2 s · 2.1k tokens · $0.004".
   Select the lookups to reopen the run log, or the token figure for usage details.
   **Sources** lists the answer's citations and console links. **Copy**, **Add to
   report**, and **Ask again** sit at the right; on older answers they appear when you
   point at or tab into the answer.
4. **Follow-ups**: up to three suggested next questions, on the latest answer only.

An answer about the product carries a **Product help** label. An answer saved before
usage was recorded shows "Usage not recorded · —" instead of a zero. In Demo Mode,
money figures are marked "simulated".

A notice at the top of an answer explains anything unusual: a partial answer, a
timed-out lookup, an unavailable model, a stopped answer, or a question chat cannot
answer from its data. A lookup can be refused for two different reasons, and the notice
says which: you lack the permission, or policy does not allow it (for example, a
private address is never sent to an outside service). **Retry** appears only when
retrying can help.

### Charts, tables, and other blocks

Numbers in blocks come only from lookups. The model chooses which result to show and
how, but it never writes the numbers, so every chart is backed by a lookup in the run
log. Each block shows its title, a caption with the window and source, and a provenance
tag: **source** for values read from a connected system, **code** for values the
platform computed, and **AI** for text the assistant wrote, such as a brief's narrative
or a callout. A chart, table, or key figure is never AI-written. When a block shows the
top N of a larger total, its caption says so.

Block types include key-figure groups (with a gauge for the Active Risk Index); bar,
horizontal bar, stacked bar, line, area, donut, sparkline, and funnel charts; heatmaps;
tables; case lists; timelines; entity cards; ATT&CK technique cards; query blocks; and
guides with console links. A **Brief** groups several results into sections, for
example for a shift handoff.

Every block has **Add to report** and a `⋯` menu:

| Action | What it does |
|---|---|
| Expand | Opens the block in a wide view |
| Show as | Switches to another view of the same numbers, such as bars as a donut. Only views that tell the truth are offered: a donut or stacked bar appears only when the parts add up to a whole. |
| Show table / Show chart | Flips between the chart and its data |
| Copy data | Copies the rows as tab-separated text. Indicators are defanged by default (`hxxp`, `[.]`), and the menu has a toggle. |
| Download CSV / Download JSON | Saves the block's data. CSV cells that look like formulas are neutralized. |
| Copy query | Copies the exact query behind the block |
| Open in Logs / Open in Cases | Opens the console view of exactly this data, with the same query, source, and absolute time window. Offered only when the console can show the same filter. |

A table shows ten rows inline, and **View all** opens the rest. A lookup that returns
no rows adds no empty chart or table; the answer says so in words. A count of zero is
still a figure and is shown, and a duration of zero reads in its unit, such as "0 min";
a duration measured in minutes or hours that is under one second reads "< 1 min". You
can also ask for a
different view in words, such as "show that as a donut" or "now by host": the assistant
reuses the earlier lookup or its stored result.

### Sources, citations, and console links

**Sources** under an answer lists what it relied on:

- **Help Center citations** (`D1`, `D2`, …) open the matching section of the Help
  Center for your installed version.
- **Case citations** open the case in Case Manager. **ATT&CK citations** show the
  technique ID and name. **Knowledge citations** show the retrieved excerpt as
  untrusted text and never link.
- **Console links** open the page or Settings section the answer refers to, such as
  **Settings → Security & access → Users**. When you lack the permission for a
  destination, it appears as plain text with the permission it needs.

The assistant can cite and link only destinations the server recognizes; it never
writes its own links.

## Tokens and cost

Chat shows token use and cost before, during, and after each question.

- **Before you send:** `≈ 1.2k` is the estimate for your next request: the system
  instructions, the part of this conversation that will be sent (the last 12 exchanges),
  and your draft, at about four characters per token. After the first answer in a
  conversation, the estimate is calibrated against what the model actually counted.
  Point at it or select it for the breakdown, the most the whole question could use, the
  model's context window, the per-question limit, and this conversation's totals. It is
  an estimate: lookups add their results to later model calls, so a question that runs
  lookups uses more than its first request.
- **Budget ring:** beside the estimate, today's AI spend against the daily budget, when
  a budget is set. It warns at the soft limit and turns critical at the limit.
- **While it runs:** the run-log header updates after every model call.
- **After it finishes:** the meta row shows the exact totals. The usage details list
  input, cached input, output, and total tokens, search-embedding calls, model calls,
  cost, model time, the model, the sources queried, and whether any figure was
  estimated (`≈`).
- **For the conversation:** the toolbar shows the running total.

Chat shares the AI budget, daily and monthly, with automatic investigations. When
either budget is close, one alert appears above the composer; it includes today's spend
when you may see it and the daily budget is the one that is close or used up. When a
budget is used up and set to block spending, the alert says AI answers are paused until
the budget resets, and **Send** stays available to everyone: a question about the
product is still answered from the Help Center at no cost, and any other question gets
a notice that the AI budget limit has been reached, without a model call. Without the
`models:read` permission the composer cannot tell whether the budget blocks, so the
alert says AI answers may be paused.

When the budget is set to warn only, questions keep running. Money and budget figures
need `models:read`, and today's spend also needs `cost:view`; without them the meter
shows tokens only.

## Stop, retry, and continue

While an answer is being written, **Send** becomes **Stop** (or press **Esc** in the
composer). Stopping is handled by the server: a model call already in progress finishes
and is recorded, no new lookup starts, and the answer is saved as **Stopped** with
whatever was completed.

- **Retry same request** repeats a failed request without billing it twice.
- **Ask again** sends the same question as a new request.
- **Continue where this stopped** appears on the latest answer when the question
  reached its lookup, model-call, or token limit. It shows the estimated extra tokens
  and picks up from there. An answer stopped by the time limit shows what was found so
  far and offers **Retry** instead.

If the connection drops, chat checks whether the answer was saved and shows it when it
was. Closing the tab does not stop a question: the answer is saved and appears when you
return. If an answer could not be saved after the model was billed, chat says so and
offers **Ask again**, which is a new, billed request.

## Reports

A report collects results from a conversation into one document you can annotate,
summarize, and share: a shift handoff, a hunt write-up, an investigation record, or a
posture review. Every figure in it comes from the read-only lookups of the answer it was
added from, and the report keeps the window, sources, and query behind each one.

### Add to a report

Select **Add to report** on a block to add that block, or on an answer's meta row to add
the whole answer as a section titled with your question. The first add creates this
conversation's draft report; the control then reads **In report ✓**, and selecting it
again removes the item. When there is room, the report panel opens beside the
conversation without taking focus; on a narrower screen it stays closed and a notice
offers **Open**.

An item is a snapshot the server takes from the saved answer, so its numbers never
change afterwards. An item whose lookup found nothing keeps its title and reads "The
lookup found nothing." instead of an empty chart or table. An answer whose charts have
expired from saved history cannot be added, and neither can anything from the
case-scoped chat in Case Manager.

### The report panel

- **Header:** the editable title, the template, the item count out of 40, and a `⋯` menu
  with Open in Reports library, Export, and Delete.
- **Summary:** see [AI summary](#ai-summary).
- **Items:** collapsed cards, each with a note field and a menu with Move up, Move down,
  Move to top, and Remove.

Notes save shortly after you stop typing. If the report changed in another tab, the
panel says "This report changed elsewhere — Reload" and keeps the note you typed.

The template names the kind of report and frames its summary and exports:
**Investigation**, **Threat hunt**, **Indicator report**, **Shift handoff**, **Posture
review**, or **Custom**. To have the assistant draft a report-shaped answer, type
`/report` and a template, for example `/report shift`: the answer comes back as a
**Brief** with that template's sections, ready to add.

### AI summary

**Generate summary** writes an executive summary and up to five next steps for the whole
report in one metered model call. Beside the button, a caption shows the estimated
tokens before you generate, and the estimated cost when you hold `models:read`.

- The summary reads a bounded digest of the report: key figures, top values, trends,
  table columns with a few identity values, case ids, and your notes as untrusted text.
  It never reads raw logs, and queries are left out. A very large report is summarized
  from a reduced digest that still keeps every item.
- It is labelled **AI-written summary**, and exports mark it "AI-generated; verify
  before acting."
- When the report changes afterwards, it shows **Out of date — Regenerate**.
- You can generate up to 10 summaries an hour; a request refused before any model call
  (for example, by the budget) does not count.

### Export

Export a report from the panel's `⋯` menu or from the Reports library:

| Format | Contents |
|---|---|
| Markdown (`.md`) | The whole document as text |
| HTML (`.html`) | A self-contained file with no scripts and a strict content security policy |
| Print / Save as PDF | The browser's print dialog, laid out for A4 |
| CSV | Every table-like block, each labelled |
| JSON | The report exactly as stored, for other tools |

Markdown, HTML, and print exports carry a header (title, author, time generated, app
version, source conversations, and each item's window and sources), the AI summary, the
items with their notes, a **Methodology & limitations** section built from the lookups
behind the numbers (queries, sampling, truncation, unavailable sources, tokens, and
cost), and an appendix of queries.

**Defang indicators** in the export menu is on by default: addresses, domains, URLs, and
e-mail addresses in Markdown, HTML, and print exports are rewritten so they cannot be
clicked (`hxxp://`, `example[.]com`), and the choice is remembered in this browser. CSV
and JSON are data formats and are never defanged; CSV cells that look like spreadsheet
formulas are neutralized.

### The Reports library

Open **Triage → Workspace → Reports** to see every report you own, with its template,
item count, source conversation, and last update. Search by title or template, and open,
rename, export, or delete any report; an open report shows the same document view as
the exports, with a link back to its source conversation.

A report holds up to **40 items**, and you can keep up to **100 reports**; at that limit,
delete one to start another. Reports are never removed automatically, and a report
survives the deletion of its conversation: its source link then reads "Conversation no
longer available". Reports are visible only to the user who created them, every change
is recorded in the audit log, and each summary writes one usage record like any other
model call.

## Conversation history

**New chat** starts an unsaved draft; it enters history after the first answer is
saved. History groups conversations into Pinned, Today, Yesterday, Previous 7 days,
Previous 30 days, and then by month.

- **Search** looks through titles, your questions, answer text, and block titles. A
  result shows the matching snippet, and opening it scrolls to and highlights the
  message.
- Each row's menu offers **Rename**, **Pin** or **Unpin**, **Open report** (when the
  conversation has one), **Export**, and **Delete**. Deleting a conversation keeps its
  report in the Reports library.
- **Export** saves the conversation as Markdown, HTML, or Print / Save as PDF, with
  indicators defanged.
- While the Chat page stays open, unsent text is kept separately for each
  conversation. It is never saved: reloading or leaving the page discards it.

History keeps up to **50 conversations** and **100 messages per conversation** for each
user; up to ten pinned conversations are exempt from the 50-conversation limit. To stay
within the storage limit, the oldest answers' charts and tables are replaced by
"Expired from saved history" placeholders before any question or answer text is
removed, and the transcript says when older messages were removed.

Saved answers are compacted. Each block keeps up to 25 table rows, cases, or timeline
events and 100 chart points (the newest 100 of a time series), and says so in its card,
for example "Showing top 25 of 200" or "Downsampled for saved history". An answer still
too large after that is shortened further and shows **Trimmed to fit storage** under that
answer when you reopen it; the conversation shows no separate note for it. A report item
is taken from the saved answer, so it holds the same rows; **Open in Logs** or **Open in
Cases**, where a block offers it, opens the same filter in the console.

Saved history is a navigation aid, not the audit or cost record: use
**Platform → Audit log** and **Analytics → Cost** for governed records.

## What chat can read

Each lookup needs the same permission as the console page that shows the same data:

| Scope | Lookups |
|---|---|
| `logs` | Search logs (one source or every browsable source) and log statistics such as top values and counts over time |
| `cases` | Search cases, read a case, explain a case decision, the shift report, and campaigns |
| `metrics` | Posture, trends, the noise funnel, case mix, timing, ATT&CK coverage, auto-close health, agent improvement, and analyst feedback |
| `intel` | Indicator reputation from your enrichment providers, ATT&CK techniques, and the knowledge corpus |
| `platform` | AI cost and usage, source health, automation status, and the audit log |
| `docs` | The bundled Help Center and the status of this deployment |

Chat cannot read users, roles, sessions, jobs, notifications, dashboards, or secrets,
and it cannot change anything. For those, it answers from the Help Center and links the
console page.

Data from your sources is treated as untrusted:

- Logs reach the model only as counts, top values, and a few sample rows, never as raw
  records.
- An indicator is sent to an enrichment provider only when it appears in your own
  words or in this question's results. Private, reserved, and loopback addresses,
  single-label hosts, and your internal domains are never sent, and e-mail addresses
  are sent only when an administrator allows it.
- Instructions found inside log values, case text, or imported documents are never
  followed.

When the assistant suggests remembering a fact, the suggestion appears under the
answer. Nothing is stored until a user with the `memory:manage` permission confirms it.

## Ask about the product

Ask how the console works, for example "How do I add a model?", "What does MTTA
mean?", or "Where do I configure SSO?". Product answers come from the Help Center bundled
with this release, cite the exact section, and link the console page. The
[KPI glossary](kpi-glossary.md) defines every dashboard metric.

**Ask about this** starts the same kind of question from where you are: it appears at the
end of the help popover of an Overview KPI (the KPI strip, MTTA, MTTR, and Dwell, plus
the Active Risk Index, Human vs AI, and noise-reduction cards) and beside the section
name in Settings.
It opens a new chat that asks a fixed question about that metric or section, so the
answer leads with the matching Help Center sections.

Product help also works when no AI model can run: before a model is configured, while
the provider is failing, or after a blocking AI budget is used up (**Send** stays
available to everyone then; see [Tokens and cost](#tokens-and-cost)). Chat answers at
no cost with the most relevant Help Center excerpt and its links, and a notice says why
the AI was not used.

## Case-scoped chat

The **Chat** tab in Case Manager uses the same assistant with the selected case as its
context. It is compact: no history, no report panel, no **Add to report**, and no `/`
or `@` menus.

Each question and its final answer text (without charts or the run log) are posted to
the case's discussion thread, where anyone who can read the case sees them. Posting
needs the `cases:comment` permission; without it, the answer is marked **Not saved**
and says it was not added to the case thread. When the save itself fails, **Run again
to save** asks the question again, which is billed again. Case conversations never
enter your personal Workspace history.

| Surface | Use it for | Where answers are kept |
|---|---|---|
| **Triage → Workspace → Chat** | Questions across telemetry, cases, metrics, intelligence, and the product | Your saved conversations and reports |
| Case Manager **Chat** tab | Evidence and follow-up for the selected case | The case thread, with your question |

## Demo Mode

With Demo Mode on (**Settings → Organization → Experimental & Demo**), chat answers from
the synthetic demo data at no cost: the starters ask about demo cases and sources,
lookups and answers are deterministic, and money figures are marked "simulated". Report
summaries are deterministic too and are not rate limited. Demo conversations and reports
are kept apart from your real ones and are removed when Demo Mode is turned off.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Enter / Shift+Enter | Send / new line |
| ↑ in an empty composer | Edit your last question |
| Esc | Stop the answer (focus in the composer, no menu open) |
| `/` at the start | Commands and saved prompts |
| `@` | Limit lookups to logs, cases, metrics, … |
| Shift+Esc | Focus the composer |
| Ctrl/⌘+Shift+O | New chat |
| Ctrl/⌘+Shift+S | Show or hide history |
| Ctrl/⌘+/ | Show all shortcuts |

Esc always closes the topmost menu or dialog first. The command palette also offers
**New chat**, **Search chats**, **Open Reports**, and **Ask AI**, which opens a new chat
with your text in the composer for you to review and send.

## Limits

Each question is bounded so cost and time stay predictable. By default a question can
use up to 5 model calls and 10 lookups (4 at a time), about 60,000 tokens, and 90
seconds, and can send up to 3 indicators to enrichment providers (10 per conversation).
Each user can run 2 questions at once. At the lookup, model-call, or token limit the
latest answer offers **Continue where this stopped**; at the time limit it shows what
was found and offers **Retry**.

Administrators change these limits under **Settings → General → Chat assistant**, which
also sets the default live mode, whether answers may be typed out, internal domains, and
whether e-mail addresses may be looked up.

Use [Investigation](investigation.md) for the broader entity and case workflow,
[Logs and search](logs-search.md) to inspect telemetry directly, and
[Case Manager](case-manager.md) for actions on a selected case.
