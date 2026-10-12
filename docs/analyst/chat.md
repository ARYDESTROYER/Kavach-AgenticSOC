---
title: Workspace Chat
description: Ask read-only questions about your security data or this console, watch every lookup as it runs, read answers with charts and citations, track tokens and cost, and collect results into reports.
---

# Workspace Chat

Open **Triage → Workspace → Chat** to ask questions about your security data or about
Agentic SOC itself. For one question the assistant can run as many read-only lookups as
the question needs, such as a log search, a case count, or a metrics query, and then
writes an answer with charts, tables, and citations built from those results. Every
lookup, token, and dollar is shown as it happens.

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
conversation's total tokens and cost, a **Report** toggle (with its item count once the
report has items), and a `⋯` menu with Rename, Pin conversation, Export conversation,
Save conversation as report, Width, and Delete.

### Conversation width

The conversation uses the width the page gives it: when you collapse the navigation
or the history rail, the answers grow into the space, up to the full width of the
screen. Prose keeps a readable line length on the left edge, and charts, tables, and the
message box use the whole width. Choose how wide it may grow under `⋯` → **Width**:

| Width | Use it for |
|---|---|
| **Comfortable** | A narrower column, up to about 1,000 px |
| **Wide** | Up to about 1,400 px, centred on very wide screens |
| **Full width** (default) | All the space beside the menus, for wide tables and charts |

The choice is saved to your account and follows you to other devices; if you chose
Comfortable or Wide before, your choice is kept. With Comfortable or Wide, a single chart
or table can also take the full width from its own `⋯` menu (**Full width**).

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
| Scope | The log source and time range in one chip, for example "Wazuh · Auto" or "Wazuh · 30d". The default, **Auto**, chooses no range and sets no outer limit: each lookup uses its own default window (see [Time windows](#time-windows)). The ranges are **1h**, **24h**, **7d**, **30d**, **90d**, **6mo**, **12mo**, and **All time**. A range you choose is used by every lookup whose question names no window, and is an outer limit: a question can narrow it but never widen it. **All time** never limits a question. The shift brief covers at most 7 days, and agent improvement always compares its own fixed periods. The run log shows the window each lookup used. Reopening a saved conversation restores its time range; the source starts at **All sources**. |
| `@` scopes | Type `@` to limit lookups to `logs`, `cases`, `metrics`, `intel`, `docs`, or `platform`. A scope you lack the permission for is shown disabled with the permission it needs. |
| `/` commands | Type `/` at the start for the commands below, your saved prompts, and the prompt library. |
| `≈ 1.2k` and the ring | The token estimate for your next request, and a ring that shows how much of the model's context window that request uses (see [Tokens and cost](#tokens-and-cost)). |
| Options `⋯` | Model, **Type out answers**, Prompts (your saved prompts, **Save current prompt**, and **Prompt library…**), and Keyboard shortcuts. A non-default model also shows as a removable chip. A reopened conversation starts on the default model; each saved answer still names the model it used. |
| Send / Stop | Send becomes Stop while an answer is being written. |

On a narrow composer, the scope chips merge into one **Scope · n** chip, the
**Read-only** chip shows only its lock, and the model chip shows only its icon.

### Time windows

A question can name any window, of any length, and the lookups use it exactly:

- **All time**, for example "How many cases have we had in total?";
- a rolling window, such as "the last 90 days", "the last 6 months", or "the past year";
- a calendar period, such as today, yesterday, this week, last week, this month, last
  month, this quarter, last quarter, this year, last year, or year to date;
- a named month, quarter, or year, such as "September 2026" or "Q3", and a date range
  such as "from 1 March to 15 April".

When the question names no window and the scope chip is on its default, **Auto**, which
sets no outer limit, each lookup uses its own default:

| Lookup | Window without one in the question |
|---|---|
| Case counts and breakdowns, case searches | All time |
| ATT&CK coverage | All time |
| Log searches and log statistics | The last 24 hours |
| Other metrics, cost, and the audit log | The last 24 hours |
| The shift brief | The last 24 hours (at most 7 days when asked) |
| Agent improvement | Always its own fixed periods: the last 7 complete UTC days against the 28 before them |

So "How many cases have we closed as false positive?" counts every case in the store,
while "How many failed logins were there?" covers the last 24 hours. Name the window
when you mean a particular period. The chip's popover says the same: "No outer limit.
Without a window in your question, case counts, case searches and ATT&CK coverage cover
all time; log, metric, cost and audit lookups and the shift brief cover the last 24 hours.
Agent improvement always compares fixed periods."

With a range chosen on the scope chip (**24h** included, which is an outer limit, unlike
**Auto**), every lookup without a window in the question uses that range instead, with
two exceptions: the shift brief covers at most 7 days of it, and agent improvement keeps
its fixed periods. With **All time**, every other lookup without a window covers all
time, logs included. The popover names the exceptions that apply to the range you chose,
and the run log shows the window of every lookup.

Calendar periods use your organization's time zone (the time zone of the SLA targets
under **Settings → General → SLA, priority & suppression**, UTC by default), and labels
name the zone. A breakdown by a
calendar unit covers whole periods: "by month for the last 6 months" covers six whole
months, the current one marked as in progress, and the caption says so, for example
"last 6 months (since May 2026)". Weeks start on Monday.

When you choose a range on the scope chip, a window the question asks for is kept
inside it. A window that lies entirely outside the chip's range is refused instead of
silently replaced: the answer says the period is outside the selected time range, and you
can set the chip to **All time** or back to its default, **Auto** (neither limits a question),
and ask again. A custom date range is not offered on the chip; name the dates in the
question instead, for example "from 1 March to 15 April".

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
| `/report <template>` | Create a report from a template (see [Reports from chat](#reports-from-chat)) |
| `/compact` | Summarize the earlier messages of this conversation to make room |

A command is listed only when you may run its lookups. Commands without a value send at
once. A command that takes a value fills the composer and selects the placeholder so you
can type the value and press Enter: the value is then your own words, which matters for
indicator lookups (see [What chat can read](#what-chat-can-read)). In the `/` and `@`
menus, **Enter** chooses an item; **Tab** moves focus and never sends.

`/compact` works in a saved conversation only, and only when chat runs without limits;
text after `/compact` is not sent. See [Long conversations](#long-conversations).

### The prompt library

Keep the questions you ask often, and start from the starter prompts that ship with
the product. Open the library with **Prompt library** in the `/` menu, or with **Prompt
library…** in the Options menu's Prompts list. It lists your own prompts and the
read-only **starter prompts**, filtered by category (Triage, Hunt, IOC, Posture,
Reporting, and App help) or by **Favorites**, with a search box.

- **Save a prompt** with **Save prompt** beside one of your earlier questions, with
  **Save current prompt** in the Options menu's Prompts list, or with **Save a copy** on
  a starter prompt. **Save prompt** appears only beside questions you typed yourself: a
  question from **Ask AI**, **Ask about this**, a starter or a follow-up is not your own
  words, so it is not saved as one. Give it a title and, optionally, a category, and star it to keep it
  at the top of the `/` menu.
- **Placeholders.** Write `{name}` in a prompt, such as `Hunt for {indicator} in the
  last {period}`. When you use it, the composer asks for each value before sending; the
  values are your own words.
- **Promptbooks** are prompts that run as several questions in a row, for example
  "Triage a case": investigate, look for related activity, then write an investigation
  brief. Each step is sent after the previous answer finishes, with a "Step 2 of 3"
  counter and **Stop**. A promptbook has 2 to 10 steps, separated by a line that holds
  only `---`. Stopping a step, or a step that fails, ends the promptbook; the remaining
  steps are not sent.

You can keep up to 50 prompts and promptbooks, of up to 2,000 characters each. They
belong to your account. A starter prompt appears only when you hold the permissions its
lookups need.

### Ask AI from other pages

**Ask AI** sits beside IP addresses, hosts, users, file hashes, domains, URLs, e-mail
addresses, detection rules, and case IDs in **Cases**, **Logs**, and **Case Manager**.
Selecting it opens a new Workspace chat and asks a fixed question about that value,
worded by the server: for a host, it asks the assistant to investigate everything about
that host, meaning its related cases, its log activity over the last 7 days, and the
users and IP addresses seen with it. The question is sent at once, like a starter;
nothing is typed into your composer.
The value came from your data, not from you, so it is treated as untrusted and does
not count as your own words for indicator lookups: chat sends it to an enrichment
provider only when one of this question's lookups returned it. A value that is not a
valid address, hash, or identifier of its kind gets no chip.

The command palette's **Ask AI** is different: it only puts the text you typed into a
new chat's composer, for you to review and send.

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
- what it did, such as "Searched logs" or "Counted cases";
- chips for the effective parameters, including the time window and source;
- a short result with row counts, the basis (exact, newest N, sample, or cached), and
  coverage such as "newest 200 of 1,284,113" or "3 of 4 sources answered";
- the exact query behind a disclosure, shown as untrusted code; and
- **Inspect**, once the lookup has finished (see [Inspect a lookup](#inspect-a-lookup)).

A count over a very large case store reports its progress while it runs, for example
"Counted 42,000 of 118,402 cases…". Model calls add no rows of their own; their tokens
tick on the header. While the assistant waits on the model, one row shows **Thinking**,
or **Writing the answer** when it has been asked to finish. A few quiet rows explain
what the assistant did to keep going:

| Row | Meaning |
|---|---|
| Continued the answer (part 2) | The model reached its output length and the answer carried on in another model call; the text keeps streaming and is never cut |
| Earlier messages were summarised to keep going | Earlier messages of this saved conversation were folded into a summary to fit the model's context window |
| Already ran as t2 in this question | The same lookup with the same inputs was asked for again, so its earlier result was reused instead of running it twice |
| Wrapped up after a very long investigation | The question ran for an exceptionally long time, so the assistant wrote its answer from what it had gathered |
| Waiting for another answer to finish | You, or the backend, already have the maximum number of answers running; this question starts as soon as one finishes (after five minutes it stops and offers Retry) |

When the answer is done, the last model call stays as one **Wrote the answer** row, and
a model call that failed or timed out keeps its row. When the answer starts, the run log
folds into the answer's meta row, where you can reopen it.

### Leave and come back

You do not need to stay on the Chat page while an answer is being written. Leave for
another page and the answer keeps going; come back and the run log and **Stop** pick up
where they are, live. After a page reload, a running answer is rejoined the same way.
Other open tabs of the console show the same working indicator. When you are signed in,
so does the console in your other browsers and on your other devices, and an answer you
read in one of them is no longer marked as new in the others.

While chat works away from the screen:

- the **Chat** item in the navigation shows a turning ring; an accent dot means a new
  answer you have not read, amber means a question you have not opened yet is waiting
  for your input, and red means an answer failed;
- the logo can show a thin turning ring too (an administrator can turn this off, and a
  custom logo itself never moves);
- the browser tab title starts with **●** while an answer is being written and **✓**
  when one is ready; and
- when an answer is ready and Chat is not on screen, you get one **Answer ready**
  notice with **Open**. If the first answer in a new chat could not be completed or
  saved, the notice offers **Ask again** instead: a question you typed comes back in the
  message box for you to send, and an **Ask AI** or **Ask about this** question is asked
  again as it was, never put in the message box.

History rows show the same states: answering, needs your input, answer failed, or new
answer. With reduced motion, the ring is still and its tooltip says "Working". A Case
Manager chat keeps its transcript when you switch tabs and shows its own indicator on
the case.

## Read an answer

A finished answer reads from top to bottom:

1. **The answer**: the direct answer first, then the evidence. A long answer with four
   or more headings starts with a **Contents** list, and a long answer offers **Jump to
   end**.
2. **Blocks**: charts, tables, and other results (see below).
3. **The meta row**: one line such as "4 lookups · 6.2 s · 2.1k tokens · $0.004".
   Select the lookups to reopen the run log, or the token figure for usage details.
   **Sources** lists the answer's citations and console links. Thumbs up and thumbs
   down rate the answer (see [Rate an answer](#rate-an-answer)). **Copy**, **Add to
   report**, and the **More actions** menu (Copy answer, Add answer to report, **Add to
   case…**, and **Ask again**) sit at the right; on older answers they appear when you
   point at or tab into the answer.
4. **Follow-ups**: up to three suggested next questions, on the latest answer only.

An answer about the product carries a **Product help** label, shown only when no data
lookup ran. An answer saved before usage was recorded shows "Usage not recorded · —"
instead of a zero. In Demo Mode, money figures are marked "simulated".

A notice at the top of an answer explains anything unusual:

| Notice | What it means |
|---|---|
| Answered with what chat can read | Chat looked things up and answered, but part of the question is outside what its lookups can read |
| Not something this assistant can do | Nothing chat can read applies; the answer links the console page for it when there is one |
| Stopped repeating the same lookup | The assistant kept asking for the same results without making progress, so it answered from what it had gathered |
| Some lookups were not allowed | You lack a permission, or policy does not allow the lookup (for example, a private address is never sent to an outside service); the notice says which |
| Stopped | You pressed Stop; what was done is kept |
| Partial answer | A lookup or a model call failed, or the model provider stopped responding |
| Chat spending limit reached | The optional daily chat spending limit was reached (see [Tokens and cost](#tokens-and-cost)) |

**Retry** appears only when retrying can help. A quiet line under an answer says when
earlier messages were summarised to keep the conversation going.

### Questions that need your input

When a question is ambiguous and there is no sensible default, the assistant asks
instead of guessing. The answer is a short question with up to four options; choose one,
or choose **Something else…** and type your own answer. The conversation's history row
shows **Needs input** until you reply. The amber mark on **Chat** shows only until you
open the question, and when you next open Chat it starts on your newest conversation
rather than on a question you have already seen.

### When nothing matched

When a lookup finds nothing, the answer says so in words, and one-click suggestions
under it widen the search, for example a longer time window or a broader filter
("Nothing matched. Widen the search:"). Selecting one sends it as your next question.

### Charts, tables, and other blocks

Numbers in blocks come only from lookups. The model chooses which result to show and
how, but it never writes the numbers, so every chart is backed by a lookup in the run
log. Each block shows its title, a caption with the window, the source, and how the
number was counted (for example "6,438 cases · exact"), and a provenance tag: **source**
for values read from a connected system, **code** for values the platform computed, and
**AI** for text the assistant wrote, such as a brief's narrative or a callout. A chart,
table, or key figure is never AI-written. When a block shows the top N of a larger
total, its caption says so.

Case counts in chat are exact across your whole case store, however large: chat never
presents a sample as a total. If the store fails part-way through a count, the answer
says how much was counted instead of showing a smaller number as exact.

Block types include key-figure groups (with a gauge for the Active Risk Index); bar,
grouped bar, horizontal bar, stacked bar, line, area, donut, sparkline, and funnel
charts; heatmaps; tables; case lists; timelines; entity cards; ATT&CK technique cards;
query blocks; and guides with console links. A **comparison** sets two or more periods
side by side, for example this quarter against the last: tiles with the absolute and
percentage change, grouped columns, and a table. A change from zero reads "new", never
infinity, and a figure based on fewer than 20 cases is marked as a small sample. A
**Brief** groups several results into sections, for example for a shift handoff; an
infographic Brief leads with key figures and trend lines and lays its charts out in a
grid.

Charts over time read in calendar terms, such as "Mar 2026" or "W14 2026", name their
time zone, and draw the current period lighter with "(in progress)". On a time chart you
can:

- **Group by** a coarser unit, such as days into weeks or weeks into months, when the
  data allows it; the table, Copy data, and the downloads follow the grouping shown.
- **Zoom** a line or area chart: drag across it, or select one point and Shift-select
  another; with the keyboard, Shift+←/→ then Enter. **Reset zoom** shows the whole
  series again.
- **Hide or show a series** by selecting it in the legend; at least one stays visible.

All of these change only the view of the same numbers; nothing is looked up again.

Every block has **Add to report** and a `⋯` menu:

| Action | What it does |
|---|---|
| Expand | Opens the block in a wide view |
| Full width | Lets the block use the whole conversation width (offered when there is room to gain) |
| Show as | Switches to another view of the same numbers, such as bars as a donut. Only views that tell the truth are offered: a donut or stacked bar appears only when the parts add up to a whole. |
| Show table / Show chart | Flips between the chart and its data |
| Copy data | Copies the rows as tab-separated text. Indicators are defanged by default (`hxxp`, `[.]`), and the menu has a toggle. |
| Download CSV / Download JSON | Saves the block's data. CSV cells that look like formulas are neutralized. |
| Download PNG / Download SVG | Saves the chart as shown, with its grouping, zoom, and hidden series stated on the image |
| Copy query | Copies the exact query behind the block |
| Open in Logs / Open in Cases | Opens the console view of exactly this data, with the same query, source, and absolute time window. Offered only when the console can show the same filter. |

A table shows ten rows inline, and **View all** opens the rest. A lookup that returns
no rows adds no empty chart or table; the answer says so in words. A count of zero is
still a figure and is shown, and a duration of zero reads in its unit, such as "0 min";
a duration measured in minutes or hours that is under one second reads "< 1 min". You
can also ask for a different view in words, such as "show that as a donut" or "now by
host": the assistant reuses the earlier lookup or its stored result.

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

### Inspect a lookup

Select **Inspect** on a finished lookup in the run log to see exactly what it did, in a
side panel:

- **What was sent**: the lookup's parameters and the exact query as it ran;
- **What the model saw**: the result as the model received it, which is counts, top
  values, and a few sample rows, never raw log records;
- its time, rows, and tokens.

Everything in the panel came from logs or the model, so it is shown as plain text, and
invisible or look-alike characters are written as visible escapes (such as `\u200b` for a zero-width space) so
"admin" with a hidden character never looks like "admin". **Retry step** asks again in a
new question, for a lookup that failed, timed out, was stopped, or was skipped. **Explain
this step** asks the assistant what the lookup did and why. Results are kept for your
100 most recent saved answers; for older ones the panel says the result is no longer
stored.

### Rate an answer

Use thumbs up or thumbs down under an answer. A thumbs down can carry a reason (Wrong,
Incomplete, Slow, or Other) and, with **Add details**, a comment of up to 1,000
characters. Rating an answer again replaces your earlier rating, and a reopened
conversation shows the ratings you gave. Ratings belong to your account and are
recorded in the audit log without the comment; they are never used to train a model,
and they never change a case. Ask chat "how have my chat ratings looked this month?"
for your own totals.

### Add an answer to a case

**Add to case…** (in **More actions**) posts a Workspace answer to a case's discussion
thread as your own comment. Pick the case by ID or by searching, read the exact comment
that will be posted, and select **Post comment**. The comment holds your question and
the answer text, with the sources the answer cited listed at the end. For an answer to
an option you picked, the question reads as your original question and the option, for
example "Show me the trend → Cases". Charts and
tables stay in chat, and mentions in the answer notify no one. A very long answer is
shortened to fit the case thread, and the dialog says so. Posting needs the
`cases:comment` permission and never changes the case's status, verdict, or
disposition. Nothing is added to a case without this confirmation.

## Tokens and cost

Chat shows token use and cost before, during, and after each question.

- **Before you send:** `≈ 1.2k` is the estimate for your next request: the system
  instructions, the part of this conversation that will be sent, and your draft, at
  about four characters per token. After the first answer in a conversation, the
  estimate is calibrated against what the model actually counted. The ring beside it
  shows how much of the model's context window that request fills, for example "12%".
  Point at either, or select the estimate, for the breakdown, the projected cost, the
  model's context window, and this conversation's totals. When chat runs without
  limits, a long saved Workspace conversation is summarised automatically near the
  limit, so the chat keeps going; there is no hard cap. In Case Manager chat, in an
  unsaved conversation, and when an administrator has set per-question limits, only
  the newest exchanges that fit are sent instead (see
  [Long conversations](#long-conversations)); the card's note about automatic
  summaries currently appears in Case Manager chat and in an unsaved conversation too,
  where it does not apply.
  It is an estimate: lookups add their results to later model calls, so a question
  that runs lookups uses more than its first request.
- **Daily AI budget:** the same card shows today's AI spend against the daily budget,
  when one is set and you may see it. Automatic investigations count against that
  budget; chat is recorded in the cost ledger but is not paused by it.
- **While it runs:** the run-log header updates after every model call.
- **After it finishes:** the meta row shows the exact totals. The usage details list
  input, cached input, output, and total tokens, search-embedding calls, model calls,
  cost, model time, the model, the sources queried, and whether any figure was
  estimated (`≈`).
- **For the conversation:** the toolbar shows the running total.

**Chat is not limited by the AI budget, daily or monthly.** That budget protects
automatic investigations: when it is close or used up, one alert above the composer
says what happens to them (they pause, and new cases wait for an analyst, when the
budget is set to block), and chat keeps answering. Chat's spend does not count against
the daily or the monthly budget, so asking questions never pushes investigations to a
human. Every chat model call is still
recorded in the usage ledger with its cost, and **Analytics → Cost** shows it.

An administrator can set an optional **daily chat spending limit** under **Settings →
General → Chat assistant**. Once today's chat spend (since 00:00 UTC) reaches it, chat
starts no new model calls: a new question gets the notice "Chat spending limit
reached" without a model call, and an answer that was already being written stops where
it is and says so. A question about the product is still answered from the Help Center
at no cost. The limit is off by default, and it is chat's only spending limit: there is
no monthly chat limit.

Money and budget figures need `models:read`, and today's spend also needs `cost:view`;
without them the meter shows tokens only. Report summaries are not chat questions:
each one is a metered call that counts against the daily AI budget.

## Stop, retry, and ask again

While an answer is being written, **Send** becomes **Stop** (or press **Esc** in the
composer). Stopping is handled by the server: no new lookup starts, a model call in
progress is abandoned at once (and still recorded in the usage ledger), and the answer
is saved as **Stopped** with whatever was completed. When an administrator has set
per-question limits, a model call in progress finishes instead.

- **Retry same request** repeats a failed request without billing it twice.
- **Ask again** sends the same question as a new request.

Answers are never cut short: when the model reaches its output length, the answer
continues in another model call and keeps streaming. There is no **Continue** button.

If the connection drops, chat rejoins the answer and shows it when it is done. Closing
the tab does not stop a question: the answer is saved and appears when you return. If
an answer could not be saved after the model was billed, chat says so and offers **Ask
again**, which is a new, billed request.

An answer runs only while its session and access last. Signing out, or ending the
session in **Sessions & activity** (yourself or an administrator), stops the answers
that session started at once; signing out everywhere, or disabling or deleting the
account, stops all of the account's answers. Nothing more is looked up and nothing is
saved, and the answer ends with "Your session ended". A role change that removes
access an answer relies on stops it the same way, with "Your access changed"; ask again
to use your current access. A change that only adds access stops nothing.

## Long conversations

A conversation has no message limit and no token limit. In a saved Workspace
conversation, when chat runs without limits (the default), the assistant keeps the
newest exchanges word for word as the conversation grows and folds older ones into a
running summary, so the next request still fits the model's context window. The run
log shows "Earlier messages were summarised to keep going" when this happens.

There is no running summary in Case Manager chat, in a conversation that is not saved,
or when an administrator has set per-question limits (**Bounded**). There, once a
conversation is long, only the newest exchanges that fit are sent with each question,
and older ones are left out of what the model sees, without a notice; they stay in the
transcript. If a question depends on
something said much earlier, repeat it in your question.

Inside a single long investigation, older lookup results are shortened to their
headline lines, and the assistant can read any of them back in full when it needs them.

Type `/compact` to summarize the earlier messages now, for example before you start a
new line of questions in the same conversation. It answers with how many exchanges were
summarised; there is nothing to summarize in a new conversation. `/compact` works only
in a saved Workspace conversation when chat runs without limits; elsewhere it says why
nothing was summarised.

The reply is a short note, not an answer: it says what was summarised and what it cost
(**No model call · $0** when no model was used, as in Demo Mode), names no data source,
and has none of an answer's actions (rating, copy, **Add to case**, **Add to report**,
**Ask again**). The assistant does not see the note in later questions, a later
`/compact` does not summarise it again, and **Save conversation as report** and **Export
conversation** leave it out.

## Reports

A report collects results from a conversation into one document you can annotate,
summarize, and share: a shift handoff, a hunt write-up, an investigation record, a
monthly SOC report, or a posture review. Every figure in it comes from the read-only
lookups of the answer it was added from, and the report keeps the window, sources, and
query behind each one.

### Reports from chat

Ask for a report and chat creates it for you. A question such as "Create a monthly SOC
report for September" or `/report monthly` runs the lookups the report needs, writes
the answer as a **Brief** with that template's sections, and saves it to the Reports
library. A line under the answer says **Saved to Reports** with the report's title,
**Open**, and **Export**. The server creates the report from the saved answer; the model
only names its title and template. When the save could not happen (for example,
because you already have 100 reports), the line says why and, when trying again can
help, offers **Save as report**. A stopped or failed answer is not saved as a report,
and case-scoped chat never creates one.

| Template | Sections |
|---|---|
| `shift` | Summary, open work, key metrics, next steps |
| `posture` | Summary, key metrics, trends, noise reduction, next steps |
| `investigation <case id>` | Summary, evidence, timeline, decision, next steps |
| `hunt <indicator or behaviour>` | Hypothesis, findings, affected entities, related cases, next steps |
| `ioc <indicator>` | Indicator, reputation, sightings, related cases, next steps |
| `executive <period>` | Summary, volume, quality, response times, noise reduction, next steps |
| `monthly <month>` | Summary, volume by week, quality, response times, noise reduction, top cases, next steps |
| `infographic <period>` | Key figures, volume, quality, response times, noise reduction, laid out as an infographic |
| `investigation_brief <case id>` | Assessment, key findings, affected entities, ATT&CK, next steps, what could not be checked |
| `custom` | Summary, findings, next steps |

An investigation brief is advisory: it is labelled so, because the deterministic case
policy, not the brief, decides a case.

**Save conversation as report** in the thread `⋯` menu saves the whole conversation as
a new report, one section per answer with your question as its heading, up to the
report's item limit; answers that do not fit are counted in the confirmation.

### Add to a report

Select **Add to report** on a block to add that block, or on an answer's meta row to add
the whole answer as a section titled with your question. The first add creates this
conversation's draft report; the control then reads **In report ✓**, and selecting it
again removes the item. When there is room, the report panel opens beside the
conversation without taking focus; on a narrower screen it stays closed and a notice
offers **Open**.

An item is a snapshot the server takes from the saved answer, so its numbers never
change afterwards. A whole answer keeps all of its text: a long one continues in
further sections titled "(continued)", and removing the first section removes the rest.
An item whose lookup found nothing keeps its title and reads "The lookup found
nothing." instead of an empty chart or table. An answer whose charts have expired from
saved history cannot be added, and neither can anything from the case-scoped chat in
Case Manager.

### The report panel

- **Header:** the editable title, the template, the item count out of 60, **Download
  PDF**, and **Export**.
- **Summary:** see [AI summary](#ai-summary).
- **Items:** collapsed cards, each with a note field and a menu with Move up, Move down,
  Move to top, and Remove.

Notes save shortly after you stop typing. If the report changed in another tab, the
panel says "This report changed elsewhere — Reload" and keeps the note you typed.

The template names the kind of report and frames its summary and exports:
**Investigation**, **Threat hunt**, **Indicator report**, **Shift handoff**, **Posture
review**, **Executive summary**, **Monthly SOC report**, **Infographic**,
**Investigation brief**, or **Custom**.

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

**Download PDF** opens the browser's print dialog, already named after the report, where
you choose Save as PDF. **Export** opens one menu with every format:

| Format | Contents |
|---|---|
| PDF (`.pdf`) | The browser's print dialog, laid out for A4 |
| Word (`.docx`) | The whole document, with headings, tables, and notes, ready to edit |
| Excel (`.xlsx`) | A **Report** sheet with the document, then one sheet per table with exact values |
| Markdown (`.md`) | The whole document as text |
| HTML (`.html`) | A self-contained file with no scripts and a strict content security policy |
| CSV (all tables) | Every table-like block, each labelled |
| JSON | The report exactly as stored, for other tools |

PDF, Word, Markdown, and HTML exports, and the Excel **Report** sheet, carry a header
(title, author, time generated, app version, source conversations, and each item's
window and sources), the AI summary, the items with their notes, a **Methodology &
limitations** section built from the lookups behind the numbers (queries, sampling,
truncation, unavailable sources, tokens, and cost), and an appendix of queries. Text
from logs is escaped in Markdown so it cannot turn into formatting or links.

**Defang indicators** in the export menu is on by default: addresses, domains, URLs, and
e-mail addresses in PDF, Word, Markdown, and HTML exports and on the Excel **Report**
sheet are rewritten so they cannot be clicked (`hxxp://`, `example[.]com`), and the
choice is remembered in this browser. The Excel table sheets, CSV, and JSON are data and
are never defanged, so they round-trip exactly; CSV and spreadsheet cells that look like
formulas are neutralized. While an export is being prepared, the menu shows its progress
and cannot start a second one; a failed export says why and offers **Retry**.

### The Reports library

Open **Triage → Workspace → Reports** to see every report you own, with its template,
item count, source conversation, and last update. Search by title or template, and open,
rename, export, or delete any report; an open report shows the same document view as
the exports, with **Download PDF** and a link back to its source conversation. A report
made from an infographic Brief keeps its infographic layout.

A report holds up to **60 items**, and you can keep up to **100 reports**; at that limit,
delete one to start another. Reports are never removed automatically, and a report
survives the deletion of its conversation: its source link then reads "Conversation no
longer available". Reports are visible only to the user who created them, every change
is recorded in the audit log, and each summary writes one usage record like any other
model call.

## Conversation history

**New chat** starts an unsaved draft; it appears in history as soon as its first
question starts, marked as answering, and is saved with the first answer. History groups
conversations into Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, and then
by month.

- **Search** looks through titles, your questions, answer text, and block titles. A
  result shows the matching snippet, and opening it scrolls to and highlights the
  message.
- Each row's menu offers **Rename**, **Pin** or **Unpin**, **Open report** (when the
  conversation has one), **Export**, and **Delete**. A conversation with an answer in
  progress cannot be deleted until it finishes. Deleting a conversation keeps its
  report in the Reports library.
- **Export** saves the conversation as Markdown, HTML, or Print / Save as PDF, with
  indicators defanged.
- While the Chat page stays open, unsent text is kept separately for each
  conversation. It is never saved: reloading or leaving the page discards it.

History keeps up to **50 conversations** for each user; up to ten pinned conversations
are exempt from that limit. Messages are never removed from a conversation: every
question and every answer is kept in full, however long. A reopened conversation opens
on its newest 100 messages; a long one shows **Show earlier messages** above its first
message, with how many earlier messages there are. Each click loads the 50 before them,
in full, above your place in the transcript, so what you are reading stays where it is.
Once everything is shown, the top of the transcript reads **Start of the conversation**.
Opening a search result or a link to an older message loads the earlier messages it
needs and highlights it, and **Export** always saves the whole conversation. A
conversation that an older version of the app shortened says how many of its first
messages were removed, for example "The first 24 messages of this conversation were
removed by an older version of Agentic SOC. Messages are no longer removed."
Answers saved before this release keep their compacted
form: each block holds up to 25 table rows, cases, or timeline events and 100 chart
points, and says so in its card, for example "Showing top 25 of 200" or "Downsampled for
saved history"; the oldest of those answers' charts may read "Expired from saved
history". A report item is taken from the saved answer, so it holds the same rows; **Open
in Logs** or **Open in Cases**, where a block offers it, opens the same filter in the
console.

Saved history is a navigation aid, not the audit or cost record: use
**Platform → Audit log** and **Analytics → Cost** for governed records.

## What chat can read

Each lookup needs the same permission as the console page that shows the same data:

| Scope | Lookups |
|---|---|
| `logs` | Search logs (one source or every browsable source) and log statistics such as top values and counts over time, by any interval up to a year |
| `cases` | Search cases, exact case counts and breakdowns (by month, week, severity, status, verdict, rule, assignee, source, ATT&CK, and more, with comparisons between periods), read a case, explain a case decision, the shift report, and campaigns |
| `metrics` | Posture, trends, the noise funnel, case mix, timing, ATT&CK coverage, auto-close health, agent improvement, analyst feedback, and your own chat answer ratings |
| `intel` | Indicator reputation from your enrichment providers, ATT&CK techniques, and the knowledge corpus |
| `platform` | AI cost and usage, source health, automation status, and the audit log |
| `docs` | The bundled Help Center and the status of this deployment |

Chat cannot read users, roles, sessions, jobs, notifications, dashboards, or secrets,
and it cannot change anything. For those, it answers from the Help Center and links the
console page. A lookup input it does not understand is refused visibly in the run log,
never silently ignored.

Data from your sources is treated as untrusted:

- Logs reach the model only as counts, top values, and a few sample rows, never as raw
  records. The same holds for results the assistant reads back later in a long
  investigation and for the conversation summary.
- An indicator is sent to an enrichment provider only when it appears in your own
  words or in this question's results. Private, reserved, and loopback addresses,
  single-label hosts, and your internal domains are never sent, and e-mail addresses
  are sent only when an administrator allows it.
- Instructions found inside log values, case text, imported documents, or the
  conversation summary are never followed.

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
the provider is failing, or after the daily chat spending limit is reached. Chat answers
at no cost with the most relevant Help Center excerpt and its links, and a notice says
why the AI was not used.

## Case-scoped chat

The **Chat** tab in Case Manager uses the same assistant with the selected case as its
context. It is compact: no history, no report panel, no **Add to report**, and no `/`
or `@` menus. Its transcript stays when you switch to another tab of the case and back,
and an answer keeps running if you leave the case. Case chat keeps no running summary:
once its conversation is long, only the newest exchanges that fit are sent with each
question, and older ones are left out of what the model sees (see
[Long conversations](#long-conversations)).

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
lookups and answers are deterministic, and money figures are marked "simulated". Demo
answers cover the same ground as a live model, including any time window, breakdowns,
comparisons, reports, and clarifying questions. Report summaries are deterministic too
and are not rate limited. Demo conversations and reports are kept apart from your real
ones and are removed when Demo Mode is turned off.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Enter / Shift+Enter | Send / new line |
| ↑ in an empty composer | Edit your last question |
| Esc | Stop the answer (focus in the composer, no menu open) |
| `/` at the start | Commands, saved prompts, and the prompt library |
| `@` | Limit lookups to logs, cases, metrics, … |
| Shift+Esc | Focus the composer |
| Ctrl/⌘+Shift+O | New chat |
| Ctrl/⌘+Shift+S | Show or hide history |
| Ctrl/⌘+Shift+C | Copy the last answer |
| Ctrl/⌘+/ | Show all shortcuts |

Esc always closes the topmost menu or dialog first. The command palette also offers
**New chat**, **Search chats**, **Open Reports**, and **Ask AI**, which opens a new chat
with your text in the composer for you to review and send.

## Limits

By default chat has **no per-question limits**: a question runs until the assistant has
answered or you press **Stop**, however many lookups and model calls that takes, and
answers are never cut short. Guards still stop a question that is going nowhere: the
same lookup never runs twice in one question, a question that stops making progress is
asked to answer from what it has, a model call that goes silent for five minutes is
retried once, and an exceptionally long investigation wraps up with what it found.

Some bounds always apply:

- **Answers at once:** each user can run 4 questions at once, and the backend 16 in
  total. Over that, a new question waits ("Waiting for another answer to finish") and
  starts by itself as soon as it can; after five minutes of waiting it stops and offers
  **Retry**.
- **Indicator lookups:** a question can send up to 3 indicators to enrichment providers,
  and a conversation up to 10.
- **Spending:** the optional daily chat spending limit described under
  [Tokens and cost](#tokens-and-cost).

Administrators can switch chat to **Bounded** under **Settings → General → Chat
assistant**. Each question then stops looking things up at its limits (model calls,
lookups, tokens, and time; by default 5 model calls, 10 lookups, about 60,000 tokens,
and 90 seconds), answers from what it found, and says so. The same section sets the
answers-at-once bounds, the default live mode, whether answers may be typed out, the
daily chat spending limit, whether the logo animates while chat works, internal
domains, and whether e-mail addresses may be looked up.

Use [Investigation](investigation.md) for the broader entity and case workflow,
[Logs and search](logs-search.md) to inspect telemetry directly, and
[Case Manager](case-manager.md) for actions on a selected case.
