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
  otherwise. When the history rail has to shrink to make room, the page says "History
  collapsed to make room for the report", and closing the report brings the docked rail
  back. See [Reports](#reports).

The thread toolbar shows the conversation title (select it to rename), a **Report**
toggle (with its item count once the report has items), and a `⋯` menu. The menu's
first line is the conversation's usage, for example "This chat: 12.4k tokens · $0.03"
("Usage not recorded" for a conversation saved before usage was recorded). Then come
**Rename**, **Pin** (or **Unpin**), **Export**, **Save conversation as report**, and
**Delete**, and a **View** group with the conversation width.

### Conversation width

The conversation uses the width the page gives it: when you collapse the navigation
or the history rail, the answers grow into the space, up to the full width of the
screen. Answers keep one **reading column** on the left edge: answer text wraps before
about 90 characters a line, and small results stay in that column beside the text that
explains them. Larger results, the start screen's suggestions, and the message box use
the whole width. Choose how wide the conversation may grow under `⋯` → **View**:

| Width | Use it for |
|---|---|
| **Comfortable** | Narrower, easier to read: up to about 1,000 px |
| **Wide** | Wider: up to about 1,400 px, centred on very wide screens |
| **Full width** (default) | Fills the space beside the menus, for wide tables and charts |

The choice is saved to your account and follows you to other devices; if you chose
Comfortable or Wide before, your choice is kept. With Comfortable or Wide, a single chart
or table can also take the full width from its own `⋯` menu (**Full width**). **View**
appears only where the conversation is wider than Comfortable allows: on a phone, or
beside the history rail on a laptop screen, all three widths would look the same, so the
menu leaves them out until there is room.

A result stays in the reading column when it is small: up to four key figures, an
indicator card, a case list, ATT&CK techniques, a table of up to three columns, or a
bar, donut, or funnel chart of up to 12 categories. Time charts, wider tables, heatmaps,
timelines, queries, and Briefs use the whole width.

## Start a chat

A new chat opens on a short start screen, directly above the message box, so the
suggestions sit next to where you type and nothing moves when you send:

- **A greeting**, such as "Good afternoon, Priya", from your display name (set it on
  **Account**), else your username.
- **What changed since you were last here**, for the first hour of a visit when anything
  did (a new visit starts after 30 minutes away): "Since 09:12: 5 new cases (2 critical),
  1 of your cases changed and Wazuh quiet for 3 hours." Each part is a link that asks
  about it. Otherwise the line reads "Ask about cases, logs, metrics or this console."
- **Suggested questions**: three or four cards (four in a row on a wide screen, two by
  two on a medium one, three in a column on a phone), each a question about your own
  data right now, with a short reason under it, such as "Escalated 2 hours ago, risk 86".
- **Category pills**: **Investigate**, **Hunt**, **Posture**, **Report**, **Learn the
  app**, and **All prompts**. Each opens the [prompt library](#the-prompt-library)
  filtered to that kind of question. A pill appears only when the library holds a prompt
  in its category that you may run.

### Suggested questions

The cards are computed by code from what is in the console now, under your own
permissions: no AI model builds, ranks, or words them, and building them costs nothing.
They read the platform's own records (cases, source health, campaigns, approvals, and
spend), never raw logs. Every number on a card is exact, and a card appears only when
you hold the permissions its answer needs, so a card never offers an answer you cannot
see.

| A card about | When it appears |
|---|---|
| A case that needs a person | An escalated case, one waiting for review, or an open case whose AI verdict is Needs human, that is unassigned or assigned to you; the most urgent one |
| Your cases | Open cases are assigned to you; the card says how long ago the oldest was assigned when every case's history records its assignment, else how long ago the oldest was opened |
| Response targets | SLA targets are on and open cases are past, or close to, their response target |
| New cases | Cases have opened since your last visit |
| Case volume | New cases in the last 24 hours are at least twice the usual daily level (and 5 or more above it), or half of it or less |
| A noisy detection rule | One rule created at least 10 cases, and 30% or more of all new cases, in the last 24 hours; when the rule's id is too long to show (see below), the card asks "Which detection rule created 12 of the 40 cases in the last 24 hours, and why?" and the answer finds the rule by that count |
| A campaign | A campaign is new, or has grown, since your last visit (a new one first); the card names it by one of its cases ("the campaign that includes CASE-000046"), never by its internal id, and the answer is about the campaign that holds that case now |
| A quiet log source | A log source has gone quiet or is failing its polls; the card names it by its display name, or by its id when the name does not fit, and otherwise asks "Which log source has gone quiet, and is ingestion working?" |
| AI spending | Today's AI budget, or the chat spending limit, is mostly used (needs `models:read` and `cost:view`) |
| Your shift | The start of your shift (your first visit after 8 hours or more away), or a handoff 7 to 13 hours after it |
| The week or the month | The first visit of a new week (Monday) or a new month (the 1st) |
| A chat to continue | One of your other conversations has a new answer, or a question waiting for you, from the last 24 hours |
| A saved prompt | You starred a saved prompt or promptbook |
| A hunt | An ATT&CK technique appeared in 3 or more cases in the last 7 days |
| Approvals | Tuning changes are waiting for approval |
| Auto-close health | The auto-close health check reports auto-close as degraded or collapsed |
| Demo Mode | Demo Mode is on |

The most urgent cards come first, cards about your own cases rank higher, and a card you
have seen three times without using it gives way to others. When fewer cards apply, the
everyday questions fill the rest: which open cases need attention first, posture now, an
executive report for the last 7 days, the Active Risk Index explained, and a tour of the
console. On a fresh install with no source and no case, the first card is "How do I
connect my first log source?".

A card names a case, rule, source or technique in its question only when no word of
that name is longer than 27 characters, so a long id (an Elastic rule id has 36
characters) never adds a line to the start screen; the card is never cut short, it asks
without the name instead. The one exception is a case without a display number, which keeps its internal
id: with case numbering switched off, no other words name one case among several. A name
the card does show is kept whole: it moves to the next line rather than breaking at a
hyphen, unless it is wider than the whole card.

Selecting a card sends its question as written, at once; nothing is typed into your
message box. A card that names a case, rule, source, or technique sends that
value to the assistant marked as data from your systems, not as your own words, so an
indicator in it is looked up with an enrichment provider only when the answer's own
lookups return it (see [What chat can read](#what-chat-can-read)). Two cards act
differently: **Continue** opens that conversation, and a saved prompt card does what
**Use** does in the prompt library. The cards are a snapshot: when a number has changed
by the time you send, or the case was closed, the answer says so.

Cards refresh every two minutes while the page is visible, and when you come back to the
window after that, but never while your pointer is over them or focus is on them, so a
card never moves under you. While an answer is being written, the cards are paused.

When an administrator has turned on row-level scope for your role, cards about cases and
the catch-up line are not shown, because chat's case lookups do not apply that scope yet
and a card must never state a count the answer would contradict.

**Hide for a day.** Point at a card (or tab to it) and select **Hide for a day** in its
corner, or press **Delete** or **Backspace** on a focused card. The next suggestion takes
its place and the other cards stay where they are. A notice "Hidden for a day" offers
**Undo**, which puts the card back where it was; while the notice shows, Ctrl+Z (⌘Z on a
Mac) on the start screen does the same. The card is hidden on the server only
when the notice closes without **Undo**; that kind of card then stays away for 24 hours.

The start screen appears with its suggestions, so nothing on it moves as they arrive;
when they take longer than about half a second, placeholder cards hold their place
until they do. If the suggestions cannot be loaded, the start screen says "Couldn't
load suggestions." with **Retry**; the message box works as usual. When there is little height, the greeting
is hidden and the rest stays.

### Catching up in an open conversation

When you come back to a conversation whose last answer is 30 minutes old or more, one
quiet line above the message box can say what changed since that answer, in the same
words as the start screen. Each part asks about it in the same conversation. The line
disappears as soon as you type, an answer starts, or you select **Hide this summary**,
and it shows at most once per conversation per visit.

### Turn suggestions off

- **For yourself:** in the message box's Options `⋯`, clear **Suggestions when a chat
  starts** (the start screen's cards and the catch-up lines) or **Suggested follow-ups**
  (the chips under an answer, see [Follow-ups](#follow-ups)). Each choice is saved to your
  account. With the start screen's suggestions off, a new chat shows only the greeting,
  the line "Ask about cases, logs, metrics or this console.", and the category pills.
- **For everyone:** an administrator can turn off **Suggest questions from live data**
  under **Settings → General → Chat assistant**. New chats then offer only the everyday
  questions and no catch-up line.

Suggestions store only what they need to rotate and hide cards: which kinds of card you
saw, used, or hid, as opaque keys with counts and times, and when you last visited. No
question text, value, or answer is stored, nothing of it is sent to a model or used to
train one, it is never shown to anyone else or combined across users, and it is deleted
with your account. A suggestion you send is an ordinary question, recorded and metered
like any other.

## Ask a question

Type into the message box, which reads "Ask about cases, logs, metrics or this console"
("Ask a question" on a narrow screen), and press **Enter**; **Shift+Enter** adds a new
line. While the box is focused and empty, a muted hint at the right of its controls
reads "/ commands · @ scope". The box has a quiet frame at rest and a clearer one while
you type in it.

The composer has one row of controls under the text box:

| Control | What it does |
|---|---|
| **Read-only** | Opens **What the assistant can access**: every lookup and its data source. A lookup you may not run says which permission it needs, such as "Needs permission to read sources (sources:read)", so an administrator can grant it. A lookup an administrator switched off reads "Turned off on this deployment". |
| Scope | The log source and time range in one chip, for example "Wazuh · Auto" or "Wazuh · 30d". The default, **Auto**, chooses no range and sets no outer limit: each lookup uses its own default window (see [Time windows](#time-windows)). The popover says it in one line, "Auto: each lookup uses its own default window.", with the details under **How ranges work**. The ranges are **1h**, **24h**, **7d**, **30d**, **90d**, **6mo**, **12mo**, and **All time**. A range you choose is used by every lookup whose question names no window, and is an outer limit: a question can narrow it but never widen it. **All time** never limits a question. The shift brief covers at most 7 days, and agent improvement always compares its own fixed periods. The run log shows the window each lookup used. Reopening a saved conversation restores its time range; the source starts at **All sources**. |
| `@` scopes | Type `@` to limit lookups to `logs`, `cases`, `metrics`, `intel`, `docs`, or `platform`. A scope you lack the permission for is shown disabled with the permission it needs. |
| `/` commands | Type `/` at the start for the commands below, your saved prompts, and the prompt library. |
| Token meter | Hidden until you type (or until the conversation uses half of the model's context window). Then it reads, for example, "≈ 4.1k tokens", the estimate for your next request, with a ring that shows how much of the context window that request uses; on a narrow composer only the ring shows (see [Tokens and cost](#tokens-and-cost)). |
| Options `⋯` | Model, **Type out answers**, **Suggestions when a chat starts**, **Suggested follow-ups**, Prompts (your **Favourites** or your saved prompts, **Save current prompt**, and **Prompt library…**), and Keyboard shortcuts. A non-default model also shows as a removable chip. A reopened conversation starts on the default model; each saved answer still names the model it used. On a phone, the model list and the prompts are listed inside the menu. |
| Send / Stop | Send becomes Stop while an answer is being written. |

On a narrow composer, the scope chips merge into one **Scope · n** chip, the
**Read-only** chip shows only its lock, and the model chip shows only its icon. Every
menu and popover of the composer keeps a 16 px gap from the edge of the screen.

### Time windows

A question can name any window, of any length, and the lookups use it:

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
name the zone. Case counts, metrics and AI cost count a rolling window in whole periods,
broken down or not, so every figure in one answer covers the same span and says where it
starts: "the last 90 days" is today and the 89 days before it, "last 90 days (since 15
Jul 2026)", and "the last 6 months" is this month and the five before it, "last 6 months
(since May 2026)", the current period marked as in progress. A window of hours, such as
"the last 24 hours", is counted to the minute. A breakdown whose first period starts
before the window says so, for example "Jul 2026 (from 15 Jul)". Weeks start on Monday.

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
menus, **Enter** chooses an item; **Tab** moves focus and never sends. Each menu opens on
its first row. Group headings stay in view as the list scrolls, and each row has its
description on a second line. Pointing at a row highlights it without scrolling the
list; the arrow keys scroll it.

`/compact` works in a saved conversation only, and only when chat runs without limits;
text after `/compact` is not sent. See [Long conversations](#long-conversations).

### The prompt library

Keep the questions you ask often, and start from the starter prompts that ship with
the product. Open the library with **Prompt library** in the `/` menu, with **Prompt
library…** in the Options menu's Prompts list, or with a category pill on the start
screen, which opens it filtered to that category. It lists your own prompts and the
read-only **starter prompts**, filtered by category (Triage, Hunt, IOC, Posture,
Reporting, and App help) or by **Favourites**, with a search box.

Select a row to use it: the prompt fills the message box (or asks for its values first).
A row's `⋯` menu holds **Save a copy**. A promptbook row says how many steps it has,
such as "3 steps", and expands to show them. Closing the library without choosing
returns you to where you opened it.

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
Each answer records the mode it ran with. Under the switch, one line says what it does:
"Shows the answer as it is written." When an administrator has turned typed-out answers
off, or the selected model cannot stream, the switch is disabled and says why.

## Follow an answer as it runs

While the assistant works, a run log sits under your question. Before the first lookup
it reads "Reading your question…", then "Choosing lookups…". Its header then shows the
progress on the left, for example "Working · 3 lookups", and the running totals on the
right, for example "1.2k tokens · $0.002"; on a narrow screen the totals move under the
progress. It has one row per lookup, or per group of lookups that ran side by side. A
row shows:

- its status as an icon: a check when it is done, or the word Failed, Timed out,
  Denied, Skipped, or Stopped;
- what it is doing while it runs, such as "Searching logs", then what it did, such as
  "Searched logs" or "Counted cases", and how long it took;
- chips for the effective parameters in words, including the time window and source,
  in the same order while the lookup runs and once it has finished; a lookup over
  several sources reads "3 sources", and selecting it lists them;
- a short result with row counts, the basis (exact, newest N, sample, or cached), and
  coverage such as "newest 200 of 1,284,113" or "3 of 4 sources answered";
- the exact query behind a disclosure, shown as untrusted code; and
- **Inspect**, once the lookup has finished (see [Inspect a lookup](#inspect-a-lookup)).

While a result is still on its way, the space it will take is kept for it, so the
answer does not jump when it arrives.

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
- on a phone, where the navigation sits behind the menu button, that button shows a
  small dot while an answer is being written;
- the logo can show a thin turning ring too, on larger screens (an administrator can
  turn this off, and a custom logo itself never moves);
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

1. **The answer**: the direct answer first, then the evidence. When a block shows the
   figures, the text gives the takeaway and names at most two of them. A long answer
   with four or more headings starts with a **Contents** list, and a long answer offers
   **Jump to end**. An answer never ends with a question or an offer; suggestions go
   in the follow-ups.
2. **Blocks**: charts, tables, and other results (see below).
3. **The meta row**: one line such as "4 lookups · 6.2 s · $0.004 · Sources 3". Select
   the lookups to reopen the run log, or the cost for the usage card, which holds the
   tokens (an answer without a cost shows its token figure there instead). **Sources**
   lists the answer's citations and console links. At the right: **Copy**, thumbs up
   and thumbs down (see [Rate an answer](#rate-an-answer)), and the **More actions**
   menu (**Add answer to report**, **Add to case…**, and **Ask again**). On older
   answers they appear when you point at or tab into the answer. While the whole answer
   is in the report, an **In report** chip shows before them; selecting it takes the
   answer out. On a narrow screen the row keeps "4 lookups · 6.2 s", the thumbs, and
   **More actions**, which then also holds **Copy answer**, **Usage details**, and
   **Sources**, so no figure is ever cut.
4. **Follow-ups**: up to three suggested next questions, on the latest answer only (see
   [Follow-ups](#follow-ups)).

An answer about the product carries a **Product help** label, shown only when no data
lookup ran. An answer saved before usage was recorded shows "Usage not recorded" instead
of a zero. A figure that a lookup could not provide reads "not available". In Demo
Mode, money figures are marked "simulated".

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

### Follow-ups

Under the latest answer, up to three suggested next questions sit in one quiet row, each
with a small arrow. They are about something the answer shows, such as an entity, a
window, a breakdown, or a case: usually one or two that go deeper and one that widens,
for example "Investigate the top source IP in this answer", "Break this down by rule
instead", "Which of these cases are still open, and who has them?", "Explain T1190 and
whether other cases show it", "What else did this host do in the last 7 days?",
"Compare this with the previous week", or "Show the same for the last 30 days".

The assistant's own suggestions are kept only when they name something the answer
shows, so a hunt for one technique never suggests a different one. A suggestion names a
case only when the answer shows or names that case: a case a lookup merely read, such as
the first row of the shift report behind an "Open cases by analyst" chart, is never
offered. A case named in the answer counts in any numbering, including your own
template ("INC/2026/0042"). An answer about the
product, or a conversation without data, keeps at most two of them, and none that names
a case the answer does not name. A suggestion that
repeats a question already asked in the conversation, or that needs a lookup you may not
run, is left out. Suggestions are chosen by code from the answer and the assistant's own
list, with no extra model call.

Selecting a suggestion sends it as your next question; it counts as a suggestion, not as
your own words, for indicator lookups. When you skip the suggestions of five answers in a
row, only the first suggestion shows until you use one again (counted in this browser).
To hide follow-ups altogether, clear **Suggested follow-ups** in the message box's
Options `⋯`.

### When nothing matched

When a lookup finds nothing, the answer says so in words, and one-click suggestions widen
the search: a longer time window, every source, or the same lookup without one filter,
for example "Without the source IP filter", "Open and closed cases", "Any severity", or
"All sources". A longer window is offered only when it covers more than the search did:
a search of the last 30 days, counted in whole days, is never offered "Last 30 days"
again. They join the follow-ups' row after a muted "Widen the search:" label (on
a narrow screen the label sits on its own line with the suggestions under it) and stay
even when you turned follow-ups off, because they only repeat the lookup more
widely. Selecting one sends it as your next question, for example "Show the same without
the source IP filter".

### Charts, tables, and other blocks

Numbers in blocks come only from lookups. The model chooses which result to show and
how, but it never writes the numbers, so every chart is backed by a lookup in the run
log. Each block shows its title and a caption with the window, the source, and how the
number was counted (for example "6,438 cases · exact"). The first line of its `⋯` menu
says who produced the values: **Measured by a lookup** for values read from a connected
system, **Computed by code** for values the platform computed, and **Stated by the
model** for text the assistant wrote, such as a brief's narrative or a callout; such a
block also says "Values stated by the model, not measured" under it. A chart, table, or
key figure is never AI-written. When a block shows the top N of a larger total, its
caption says so.

When several blocks in a row share the same caption parts and the same time, the answer
states them once, in a quiet line above the first block, for example "44 cases · exact ·
last 24 hours · as of 11:13", and each block's caption keeps only what differs. A
printout, an export, a report item, and the expanded view keep each block's full
caption, because a block can travel alone.

Cases are named by their case number and title. A case without a number shows its title
followed by a short form of its ID (the full ID is in its tooltip). Verdicts, statuses,
and kinds read in words, such as "True positive", "Open → Escalated", and "IP".

Figures in an answer's text read the way its blocks show them, so one figure never
appears in two forms: a rate is a whole percent from 10% up ("78%"), with one decimal
under 10% and "<1%" for a sliver, rounded half up; a change in a rate is in points the
same way ("+36 points"); an average risk reads "7/100". The run log's step summaries
write a rate the same way ("FP rate 76%").

Case counts in chat are exact across your whole case store, however large: chat never
presents a sample as a total. If the store fails part-way through a count, the answer
says how much was counted instead of showing a smaller number as exact.

Block types include key-figure groups (the Active Risk Index tile shows a small gauge
beside its figure, with the band, such as "High", above "/100"); bar,
grouped bar, horizontal bar, stacked bar, line, area, donut, sparkline, and funnel
charts; heatmaps; tables; case lists; timelines; entity cards; ATT&CK technique cards;
query blocks; and guides with console links. A **comparison** sets two or more periods
side by side, for example this quarter against the last: tiles with the absolute and
percentage change, grouped columns, and a table. A change from zero reads "new", never
infinity, and a figure based on fewer than 20 cases is marked as a small sample. A
**Brief** groups several results into sections, for example for a shift handoff. Its
title reads "Brief: {title}" (unless the title already says brief), its window is stated
once, and it shows a **Contents** control from four sections. An infographic Brief leads
with key figures and trend lines and lays its charts out in a grid.

Charts over time read in calendar terms, such as "Mar 2026" or "W14 2026", name their
time zone, and draw the current period lighter with "(in progress)". A time chart has one
row of controls above it: **Group by** on the left, and the zoom hint ("Drag to zoom"),
the zoomed range, and **Reset zoom** on the right. On a time chart you can:

- **Group by** a coarser unit, such as days into weeks or weeks into months, when the
  data allows it; the table, Copy data, and the downloads follow the grouping shown.
- **Zoom** a line or area chart: drag across it, or select one point and Shift-select
  another; with the keyboard, Shift+←/→ then Enter. **Reset zoom** shows the whole
  series again.
- **Hide or show a series** by selecting it in the legend; at least one stays visible.
  When every line is labelled at its end, the chart draws no legend, and **Series** in
  the block's `⋯` menu shows or hides lines instead.

All of these change only the view of the same numbers; nothing is looked up again. A
horizontal bar shows its value just after the bar, and a donut's legend sits beside it on
a wide card and under it on a narrow one.

At rest a block shows only its `⋯` menu. **Add to report** appears beside it when you
point at or tab into the block, and stays while the block is in the report. The menu:

| Action | What it does |
|---|---|
| Add to report | Adds the block to this conversation's report, or removes it (also beside the menu, see above) |
| Expand | Opens the block in a wide view |
| Full width | Lets the block use the whole conversation width (offered when there is room to gain) |
| Show as | Switches to another view of the same numbers, such as bars as a donut. Only views that tell the truth are offered: a donut or stacked bar appears only when the parts add up to a whole. |
| Series | Shows or hides each line of a chart whose lines are labelled at their ends |
| Show table / Show chart | Flips between the chart and its data |
| Copy data | Copies the rows as tab-separated text. Indicators are defanged by default (`hxxp`, `[.]`), and the menu has a toggle. |
| Download CSV / Download JSON | Saves the block's data. CSV cells that look like formulas are neutralized. |
| Download PNG / Download SVG | Saves the chart as shown, with its grouping, zoom, and hidden series stated on the image |
| Copy query | Copies the exact query behind the block |
| Open in Logs / Open in Cases | Opens the console view of exactly this data, with the same query, source, and absolute time window. Offered only when the console can show the same filter. |

A list of cases names each case by its case number (**CASE-000045**) in **Show table**,
**Expand**, and **Copy data**, as the list does, and its link opens that case. A case
without a number shows its case ID. The CSV writes the number under **Case** and adds a
**Case ID** column with the internal ID, so other tools can match it; JSON keeps the
stored values.

A table shows ten rows inline, and **View all** opens the rest. A cell with no value is
left blank (a screen reader reads "None", or "Not measured" for a number), and a list of
ATT&CK techniques in a cell shows one chip per technique. A lookup that returns
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
side panel. Its header names the step and what the lookup did, such as "Step 2: Searched
logs", and states its status and time once:

- **What was sent**: which lookup ran, its parameters, and the exact query as it ran;
  the lookup is named in words with its tool name in muted text, such as "Search logs
  (search_logs)";
- **What the model saw**: the result as the model received it, which is counts, top
  values, and a few sample rows, never raw log records;
- its rows and tokens, under a heading that names what it holds, such as "Sources and
  tokens".

Queries and results keep their lines and scroll sideways on a narrow screen.

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

- **Before you send:** once you start typing, "≈ 1.2k tokens" is the estimate for your
  next request: the system instructions, the part of this conversation that will be
  sent, and your draft, at about four characters per token. With an empty message box
  the meter stays hidden until the conversation uses half of the model's context window.
  After the first answer in a conversation, the estimate is calibrated against what the
  model actually counted. The ring beside it shows how much of the model's context
  window that request fills, for example "12%". Point at either, or select the estimate,
  for the breakdown, the projected cost, the model's context window, and this
  conversation's totals. The card's history line says what the next request replays:
  "History: none yet" in a new chat, "History: 3 exchanges, summarised near the limit"
  when chat runs without limits, or "History: summary of earlier messages" after
  `/compact`. When chat runs without
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
- **After it finishes:** the meta row shows the exact cost; select it for the usage
  card, which holds the tokens. The usage details list input, cached input, output, and
  total tokens, search-embedding calls, model calls, cost, model time, the model, the
  sources queried, and whether any figure was estimated (`≈`).
- **For the conversation:** the first line of the thread `⋯` menu, for example "This
  chat: 12.4k tokens · $0.03".

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
`/compact` does not summarise it again, and **Save conversation as report** and **Export**
leave it out.

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
library. One line under the answer says so, for example "Saved to Reports: Monthly SOC
report, September 2026 · Open · Export", with no second notice. The server creates the
report from the saved answer; the model
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

Select **Add to report** on a block (beside its `⋯` menu, or in it) to add that block, or
**Add answer to report** in an answer's **More actions** menu to add the whole answer as
a section titled with your question. The first add creates this conversation's draft
report. A block's control then shows as added, and an answer shows an **In report** chip
on its meta row; selecting either again removes the item. When there is room, the report
panel opens beside the
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

- **Header:** the editable title (the panel reads "Report" until this conversation has a
  working report), the template, the item count, such as "1 of 60 items", **Download
  PDF**, and **Export**.
- **Saved from this chat:** the reports this conversation's answers saved to the Reports
  library (see [Reports from chat](#reports-from-chat)), each with **Open** and
  **Export**. The list updates when an answer in this conversation saves one, even with
  the panel open.
- **Summary:** see [AI summary](#ai-summary).
- **Items:** collapsed cards whose full titles wrap, each with a note field and a menu
  with Move up, Move down, Move to top, and Remove. With no items yet, the panel reads
  "Nothing added yet. Use Add to report on an answer or a block."

Notes save shortly after you stop typing. If the report changed in another tab, the
panel says "This report changed elsewhere" with a **Reload** button beside it, and keeps
the note you typed.

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

Every format except JSON writes severity, verdict, and status in the words the report
shows on screen, such as **Critical**, **True positive**, **Needs human**, and **On hold**.
Yes/no values read **Yes** and **No**, in the CSV too, and a query is labelled with its
language as the screen names it, such as **ES|QL** or **Query DSL**. JSON keeps the stored
values (`true_positive`, `on_hold`, `true`, `esql`) so other tools can read them.
Cases are named as the report shows them, by case number (**CASE-000045**), in PDF,
Word, Excel, Markdown, HTML, and the CSV's **Case** column; a case without a number keeps
its case ID. The CSV adds a **Case ID** column with the internal ID, and JSON keeps it as
stored, so other tools can match it.

A table cell with no value is left blank in every format, as on screen, such as a
campaign with no ATT&CK technique. In Word, Markdown, and HTML, a dash (`—`) marks only
a figure that was not measured, such as a missing count or risk score, and the
**Methodology & limitations** section says how many there are. Excel and CSV leave both
kinds of cell empty, never 0.

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
item count, source conversation (blank for a report saved by an earlier version until
you next change it), and last update. Search by title or template, and open,
rename, export, or delete any report; an open report shows the same document view as
the exports, with **Download PDF** and a link back to its source conversation. A report
made from an infographic Brief keeps its infographic layout.

A report holds up to **60 items**, and you can keep up to **100 reports**; at that limit,
delete one to start another. Reports are never removed automatically (deleting your
user account removes them, with your conversations and ratings), and a report
survives the deletion of its conversation: its source link then reads "Conversation no
longer available". Reports are visible only to the user who created them, every change
is recorded in the audit log, and each summary writes one usage record like any other
model call.

## Conversation history

**New chat** starts an unsaved draft; it appears at the top of Today as soon as its first
question starts, marked as answering, and is saved with the first answer. History groups
conversations into Pinned, Today, Yesterday, Previous 7 days, Previous 30 days, and then
by month.

A new conversation is named after its first answer, in 2 to 6 words that say what it is
about, such as "Failed logins on the VPN". Until that answer arrives, the toolbar and the
history row show the first words of your question. The name comes with the answer, at no
extra cost. A name that is too long, written all in upper case, or not in sentence case
is not used, and the conversation keeps your question as its title. A name you choose with
**Rename** is never replaced, and a Case Manager chat is never named this way.

In the docked history rail, each row and search result keeps its title on one line. A
title too long for the rail is cut at the end; point at the row or move to it with the
keyboard to see the whole title in a tooltip, with the time of its last change in UTC
(2026-10-23 15:45 UTC), as answers write times. The toolbar above the conversation shows the
whole title where it has room, and in a tooltip where it does not. On a phone, in the
history sheet, and on any touch screen, where there is no pointer to show a tooltip, a
title wraps to up to three lines in the history and in the toolbar, so the whole title is
on screen.

- **Search** looks through titles, your questions, answer text, and block titles. Every
  result shows its matching snippet under the title, as plain text with the matching
  words highlighted, and opening it scrolls to and highlights the message. The command
  palette's chat results show the same plain snippets. On a phone, the history sheet
  opens with its search field ready to type in.
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
| `metrics` | Posture, trends, the noise funnel, case mix, timing, ATT&CK coverage, auto-close health, agent improvement, analyst feedback, and your own chat answer ratings. Alert stages the counters do not cover read "not measured" (see the [KPI glossary](kpi-glossary.md#noise-reduction-funnel)) |
| `intel` | Indicator reputation from your enrichment providers, ATT&CK techniques, and the knowledge corpus |
| `platform` | AI cost and usage, source health, automation status, and the audit log |
| `docs` | The bundled Help Center and the status of this deployment |

Questions about "my cases" or cases "assigned to me" read the open cases assigned to
you, the signed-in analyst. A question that names more keeps it: "my closed cases", "my
critical cases", "my cases by severity", "my cases this week" or "compare my cases this
week with last week" read only the cases assigned to you, with that status, severity,
breakdown, period or comparison. The shift report, the posture and other figures cannot
be narrowed to your cases; an answer from them says so. With sign-in turned off, chat
cannot tell which cases are yours, so it says so and shows the open queue by assignee
instead. The suggestion "What should I do next on case …?" reads your own open cases
too, so its answer can say whether the case is your only one and list your others.
Asked right after you assign a case, it already counts and lists that case: the count
and the list always describe the same cases.

The shift report names the 5 most overdue open cases and the 5 closest to their response
target (nearest first), each with who has it; its totals count every one. An answer from
it states the total once and then says how many it lists, for example "Work the 10 cases
past SLA first, starting with the 3 most overdue: …". The brief's opening line starts
with the same case as that step, the most overdue one. Its **Needs human** figure counts
the open cases whose verdict is Needs human, the same badge its **Needs attention** list
shows, and the same figure the Standup page shows under **Needs human** (the Standup
page's **Awaiting analyst** counts a status instead; see
[Analytics and standup](analytics.md#standup-and-handoff)).

Campaigns are listed with every ATT&CK technique and shared entity, or the first few and
how many more ("T1021, T1048, T1078 and 2 more"), in the table and in the text, where the
count names what it counts ("and 2 more techniques", "and 6 more shared entities"). A
case's own techniques read the same way: every one up to four, else the first three and
how many more, beside the ATT&CK block that lists them all. An
in-depth look at a user, host, or IP lists only the campaigns that involve it: one of
their shared entities is that value, or one of their cases is about it. The table is
titled for it, for example "Campaigns involving this user".

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
context; its status line names the case by the number the case header shows (for
example "Scoped to CASE-000086"). It is compact: no history, no report panel, no **Add
to report**, and no `/` or `@` menus. On a phone, its token estimate shows as the
context ring alone once you type, so the question keeps most of the field's width. Its transcript stays when you switch to another tab of the case and back,
and an answer keeps running if you leave the case. Case chat keeps no running summary:
once its conversation is long, only the newest exchanges that fit are sent with each
question, and older ones are left out of what the model sees (see
[Long conversations](#long-conversations)).

An empty case chat offers up to three suggested questions, the ones that apply to the
case's state (a case that fits fewer of them shows one or two). They come from this list:

- "Why does this case need a person, and what would settle it?" (an escalated case, one
  waiting for review, or an open case whose AI verdict is Needs human);
- "What evidence is missing before this case can be decided?" (an open case without a
  verdict);
- "Why was this case closed that way, and who decided?" (a closed or resolved case);
- "What else has this case's main entity done in the last 24 hours?" (a case with a
  main entity);
- "Which other cases share entities with this one?" (a case that shares a campaign or
  an entity with another case); and
- "Summarise this case for a handoff note." (any case).

They name no value, because the case is already the chat's subject, and they are sent
in this case chat only. While they show, the quick actions ("Summarise the case", "Check
indicators", "Suggest remediation") stay out of the way; they appear after the first
message, or when no suggestion could be loaded.

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
the synthetic demo data at no cost: the suggested questions are built from the demo
cases and sources (with a Demo Mode card, and a "Since …" line on your first visit; on
the visit that starts your shift, the shift card comes before the Demo Mode card),
every suggestion and case chat question gets a real answer from that data, lookups and
answers are deterministic, and money figures are marked "simulated". Every demo case is
numbered with your numbering template (CASE-000001 onwards by default), the oldest first,
even when custom numbering is switched off for real cases, and cases the demo creates
while it runs continue the same sequence (one sequence for the demo, whatever your reset
period, so no two demo cases share a number; each number keeps its case's own date);
turning Demo Mode off and on again, or resetting it, gives each case the same number
again. A case you name by its internal id is answered by its number, with the id you
used beside it once. A detection rule is written the same way everywhere in an answer: its
id exactly as written (for example `demo_impossible_travel`), as the case list shows it. Demo answers cover the same ground as a live model, including any time window, breakdowns,
comparisons, reports, and clarifying questions. A question that asks to investigate or
look into a named host, user, email address, IP address, domain or file hash
("Investigate the activity of user pnair in the last 3 days") is about that entity over
the window it names. "Investigate" with a detection rule ("Investigate rule
demo_impossible_travel") counts that rule's cases by verdict; with a log source
("Investigate source Wazuh") it shows the source's newest events and says if it is
silent or disabled; with an attack type ("Investigate ransomware") it runs the hunt; and
with records Demo can list ("Investigate the false positives from yesterday") it lists
them. A technique id, cost, sources, tuning and other console words keep their own
answers ("Investigate T1059.001" describes the technique). A case is picked when the
question picks one ("Investigate the newest escalated case", "Investigate it"); a
question that names nothing else Demo can look up also starts from the newest escalated
case, and the answer says that is how it was chosen. When cases, rules or periods tie
for the highest risk, the most or the oldest, as the answer writes the figure, the
answer says so and names each of them rather than presenting one as the only one. A
demo conversation's name carries one
detail that tells it apart from similar ones where there is one: the case number (first,
so a narrow history list still shows it), the ATT&CK technique, the period, the breakdown
or the console page a product question is about, such as "CASE-000045 needs a person",
"CASE-000005 identity_signin case", "Cases by severity, last 7 days" or "Sources help".
A name can carry a detection rule id exactly as written, but only one that the
suggestion rules accept and that does not look like an address, domain or file hash. It
never repeats any other value from your logs or cases, such as an address, a host or
user name, or a case title. Report summaries are
deterministic too and are not rate limited. Demo conversations and reports are kept apart from your real
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
| Delete or Backspace | Hide a suggestion for a day (on a focused suggestion) |
| Ctrl/⌘+Z | Undo the last hidden suggestion (on the start screen) |

On the start screen the suggestions are one stop in the Tab order: the arrow keys move
between them, Home and End jump to the first and last, and Enter or Space sends the
focused one. Esc always closes the topmost menu or dialog first. The command palette also offers
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
answers-at-once bounds, **Typed-out answers** (off, or allowed and off or on by
default), **Suggest questions from live data**, the daily chat spending limit, whether
the logo animates while chat works, internal domains, and whether e-mail addresses may
be looked up.

Use [Investigation](investigation.md) for the broader entity and case workflow,
[Logs and search](logs-search.md) to inspect telemetry directly, and
[Case Manager](case-manager.md) for actions on a selected case.
