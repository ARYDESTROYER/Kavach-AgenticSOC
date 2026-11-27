# D2: data questions labelled as "Product help" (diagnosis)

Scope: screenshots 1 and 4. A data question ("Create a report of lifetime performance pls
thanks"; "The amount of total cases right now that are open, when were they all opened?
Segregate month wise pls thanks") showed the **Product help** label and the callout **"Not
something this assistant can do / Chat cannot read that data. Use the linked console page
instead."** above an answer that partly used data. Screenshot 4 had 5 lookups.

Diagnosis only. No repo file was modified. Evidence is from code reading, the live Demo
backend (`POST /api/chat/stream`, 24 questions) and UI screenshots
(`r12/shots/diag-routing-*.png`). The probe scripts are in `r12/diag/scripts/`
(`routing_probe.py`, `routing_shots.mjs`, raw output `probe_out.json`).

---

## 1. Where the label and the callout come from

| What | Code | Condition |
|---|---|---|
| "Product help" label | `webui/src/soc/chat/message/Message.tsx:286-291` | `response.answer_kind === 'product_help'` and nothing else. It does not look at `steps` (data lookups that ran). |
| Callout title "Not something this assistant can do" | `webui/src/soc/chat/message/NoticeCallout.tsx:40` (`NOTICE_TITLE.unsupported`), shown because `unsupported` is in `CALLOUT_NOTICE_KINDS` (`:18-27`) | `response.notice.kind === 'unsupported'` |
| Callout body "Chat cannot read that data. Use the linked console page instead." | `backend/app/agents/chat_protocol.py:904` (`NOTICE_MESSAGES["unsupported"]`) via `make_notice("unsupported")` | always this text. It is not checked against `console_links`, so it promises a link that was not there in either screenshot. |
| Engine sets the notice | `backend/app/agents/chat.py:2059-2061` | `header.unsupported is True` in the model's final header, and no higher-ranked notice (cancel/cap/length). |
| Engine sets `answer_kind` | `backend/app/agents/chat.py:2074`, `_answer_kind` `:2105-2107` | **`if unsupported: return "product_help"`.** This runs before the model's own `answer_kind` and before the `data_tools` counters (`:2108-2116`), so 5 successful data lookups still give "product_help". |
| Test that pins the override | `backend/tests/test_chat_engine_loop.py:576-580` (`test_unsupported_answers_are_product_help`, model said `answer_kind="data"`) | Must change together with the fix. |
| SPEC intent | `docs/research/2026-10-chat-revamp/SPEC.md:589-596` (§5.6) | "When **no granted tool covers the question**" (users, roles, sessions, jobs, notifications, dashboards, secrets). It was never meant for a question that is only partly covered. |
| $0 fallback (not involved here) | `chat.py:1994-2010` `_finish_fallback` (product_help + budget/provider notice) | Runs only when the first model call fails. Both screenshots were billed (2.4k and 20.8k tokens), so this path was not taken. |
| Demo planner | `backend/app/engine/demo_chat.py:3945-3956` (`_final_unsupported`), `:4110` (`_final_generic`), header write `:4300-4301` | See §4. |

There is **no deterministic pre-router or classifier** in production. The model chooses the
route through the protocol header. The only deterministic product-help path is the $0 fallback.

---

## 2. What production GPT receives (measured)

* System prompt (`prompts.render_chat_agent_system`, all tools granted): **9,390 chars, about
  2,347 tokens**. Screenshot 1's first answer was **2.4k tokens, 2.4 s, with no "lookups"
  in the meta row**. So GPT answered at its first step without calling any tool. It asked a
  clarifying question and set `unsupported:true`.
* Lines in the prompt that cause the problem:
  * `prompts.py:823`: `- unsupported: true only when none of your lookups can read what was asked.`
    "What was asked" is ambiguous. GPT treats a part it cannot express ("lifetime",
    "month-wise") as "none of your lookups can read" it.
  * `prompts.py:855-857` (Honesty): "When no lookup covers the question, answer from product
    knowledge, say the data is not available to chat, **set answer_kind to product_help and
    unsupported to true**, and add a console link". This tells the model to label the answer
    product help. Nothing says to answer the covered part and state the limit.
  * `prompts.py:915`: "No time window was selected: **lookups default to the last 24 hours.**"
    This is false for `search_cases` (no window means all time, `cases.py:279`) and for
    `mitre_coverage` (`metrics.py:650`). It tells the model that "lifetime" cannot be read.
  * The tool signatures (printed from `render_tool_signatures(catalogue())`) state no bounds
    and no all-time meaning. Examples: `soc_metrics(kind=…, window_hours?=24, …)` and
    `search_cases(…, window_hours?, …, limit?=20)`. Nothing says that 720 h is the maximum,
    that omitting the window on `search_cases` means all time, or that there is no `group_by`.
  * The prompt has no recipe for a report. It describes the `report` block and its templates
    (`posture|shift|…`) but never maps "performance report" or "how did we do" to
    `soc_metrics` posture + trends + timing + noise_funnel + case_mix. It also never says to
    pick a sensible default instead of asking a clarifying question. GPT-family models then
    ask: "I can't determine which lifetime performance metric you mean…" (screenshot 1).

---

## 3. Root causes, ranked

**RC1 (engine). `unsupported` overrides everything.** `chat.py:2105-2107` forces
`product_help` even when `data_tools > 0` and the model stated `answer_kind:"data"`.
`chat.py:2060` adds the callout whatever ran. The UI label (`Message.tsx:286`) trusts
`answer_kind` alone. Screenshot 4 (5 lookups, a KPI block, 8 sources) therefore shows
"Product help" and "Chat cannot read that data".

**RC2 (prompt). The protocol has one bit for three different situations:** (a) the domain
cannot be read (users, roles, jobs…); (b) the question is only partly covered (a window
longer than a tool allows, a grouping no tool offers, sampled data); (c) the lookup failed or
the record was not found. `prompts.py:823` and `:855-857` push the model to set the bit for
(b), and the Demo planner even sets it for (c).

**RC3 (tools). The asked-for shape cannot be expressed, so declaring "unsupported" is the honest move:**
* No lifetime or all-time metrics. `SocMetricsInput.window_hours le=720`
  (`metrics.py:178`), `MAX_WINDOW_HOURS = 720` (`common.py:158`). Also in `search_cases`
  (`cases.py:105`) and `cost_usage` (`metrics.py:834`). A model asking for 90 days
  (`window_hours=2160`) gets a hard failure, not a clamp (verified):
  `parse_input(SocMetricsInput, {'kind':'posture','window_hours':2160})` gives
  `"Invalid input: check window_hours"`. When the range chip covers more than 30 days,
  `metric_window` caps it and sets `window_capped` (`metrics.py:143-144, 310-311`). That is
  the "metrics were capped to 30 days" in screenshot 1, second answer.
* No case aggregation by time bucket or field. `search_cases` returns at most 50 rows
  (`cases.py:108`) and sends the model 10 (`_OBS_CASES = 10`, `cases.py:55`). Its breakdown
  covers only verdict and status, and only when every match fits in one page
  (`cases.py:258, 273`). There is no month, week or day bucket and no severity, assignee
  or rule grouping. `group_by` is **silently dropped** because `ToolInput` uses
  `extra="ignore"` (`common.py:122`; verified: `{'group_by':'month'}` parses with no error).
  "Segregate month wise" over 253 open cases is impossible. GPT says so and sets the flag
  (screenshot 4: "returns only a partial sample of case records, not all 253 creation dates").
* Metric periods are hourly or daily over at most 30 days. There is no `interval=month`.
* Truncation that feeds the "partial" wording: the case scan stops at `CASE_SCAN_LIMIT = 5_000`
  (`cases.py:54`), and posture `open_now` becomes "a lower bound" whenever
  `store_total > len(cases)` (`metrics.py:345-351`). The observation budget is
  `observation_chars = 6_000` (`config.py:1580-1583`) **divided across the parallel calls**,
  with a 1,500-char floor (`chat_protocol.py:639, 660-662`). With 4 calls each gets 1,500
  chars, gets `_shrunk_for_prompt`, and GPT reports "the dataset was also truncated".

**RC4 (prompt). No guidance on best-effort answers or report recipes.** See §2. The first
turn in screenshot 1 made zero lookups.

**RC5 (copy). The callout promises a link that is not there.** It says "Use the linked
console page instead" whether or not `console_links` resolved (`chat.py:2060`, with no
check). Neither screenshot had a link.

**RC6 (tool KPI). The `search_cases` "Still open" figure contradicts itself.** With
`status_group=active`, every match is open, so the open count equals `count` exactly.
`cases.py:307-314` still counts only the returned page and marks it as a bound: "≥10 in the
returned page" next to "Matching cases 19" (live shot `diag-routing-open-by-month.png`). The
KPI tile then clips it to "≥… in the returned …" (screenshot 4).

---

## 4. Live Demo planner probe (24 questions)

Demo Mode replaces the model with a deterministic planner, so these results show planner and
tool coverage, not GPT routing. Legend: **OK**, **DEGRADE** (answered something else or
silently changed the window), **FAIL** (wrong route or a false label).

| # | Question | Result | What happened |
|---|---|---|---|
| 1 | Create a report of lifetime performance pls thanks | **FAIL** | `_CHANGE_RE` (`demo_chat.py:917-921`) matches the leading **"create"** as a write request (`classify` `:1299`). The answer is "I can't change that from chat…", from `app_help` only, with a "Report" made only of Help Center links. Shows the "Product help" label (`diag-routing-lifetime-report.png`). |
| 2 | Open cases… segregate month wise | **DEGRADE** | `search_cases(status_group=active, limit=10)` + `case_mix` (24 h). No month breakdown, and the request is silently ignored. An unrelated "45 cases in the last 24h" is added. "Still open ≥10" sits next to "19 matching" (RC6). |
| 3 | Last 90 days or whatever reports you can | **FAIL** | Fallback: "I could not map that to one specific lookup…", `app_help` + open cases, `mixed`. |
| 4 | How many cases were created each month this year? | **DEGRADE** | "83 cases" all time, no months. "This year" is not parsed. Plus `case_mix` over 24 h. |
| 5 | Top rules in the last 90 days | **DEGRADE** | `log_stats(time_from=now-30d)`. 90 days is silently cut to 30 (`_hours_from` caps at 720, `:1014-1040`; `_metric_window` `:1465-1467`) and the answer never says so. |
| 6 | Show me the MTTR trend over the last 30 days | **FAIL** | Fallback "could not map". `_metric` matches MTTR only next to "our/we/my" or a definition cue (`:1364-1366`). Should run `soc_metrics(kind=timing, window_hours=720)`. |
| 7 | Which hosts generated the most alerts this week? | OK | `log_stats` by host over 7 d (sampled, and the answer says so). |
| 8 | Compare this month vs last month: cases, FP rate, MTTR | **DEGRADE** | FP-case search + `case_mix` over 720 h. No `compare_previous` and no MTTR. "This month" is not parsed. |
| 9 | List open critical cases | OK | Plus a `case_mix` over 24 h that is not needed. |
| 10 | Explain case case-0001 (no such case) | **FAIL (label)** | `get_case`/`explain_decision` return "Case not found". `_final_generic` sets `unsupported = not data and intent in _DATA_INTENTS` (`:4110`). The answer shows "Product help" + "Chat cannot read that data" for a missing case (`diag-routing-explain-missing-case.png`). |
| 10b | Explain case demo-00000539-0004 (real) | OK | `get_case` ∥ `explain_decision`, `data`. |
| 11 | Look up 8.8.8.8 | OK | Indicator + logs + cases. |
| 12 | Is 185.220.101.4 malicious? | OK | |
| 13 | How do I configure SSO? | OK | `product_help` with a guide block. This is the label's intended use. |
| 14 | Give me a shift handover report | OK | shift_report + posture + campaigns, report block. |
| 15 | What is our false positive rate over all time? | **DEGRADE** | Posture over 24 h. "All time" is not supported or mentioned. |
| 16 | How many cases are open right now, grouped by severity? | **DEGRADE** | No severity grouping. Verdict mix over 24 h instead. |
| 17 | Which analysts closed the most cases last week? | **DEGRADE** | No grouping by assignee or closer. Lists closed cases instead. |
| 18 | Show failed logins by source IP in the last 24 hours | OK-ish | `log_stats` (contains "fail") + brute-force cases. |
| 19 | What did the AI spend this month? | **DEGRADE** | `cost_usage` over 24 h. "This month" is not parsed. |
| 20 | Why was case demo-00000539-0000 closed? | OK | |
| 21 | Show cases opened per month for the last 90 days | **DEGRADE** | 720 h, labelled "last 720h". No months, and 90 days becomes 30 silently. |
| 22 | Give me a posture report for the last quarter | **DEGRADE** | Posture/trends/noise over **24 h**. "Quarter" is not parsed. |
| 23 | Show all-time case stats | **DEGRADE** | "85 cases" + verdict mix over 24 h, which mixes two windows. |

Totals: 10 OK, 10 DEGRADE, 4 FAIL (3 wrong routes + 1 false unsupported label).

Window labels are machine-shaped ("last 720h", "last 168h") in prose and block captions
(`window_label`). They should read "last 30 days" and "last 7 days".

---

## 5. Fixes

### Engine and protocol (backend/app/agents)
1. **Respect evidence over the flag.** In `_answer_kind` (`chat.py:2105`), honour
   `unsupported` only when `self.data_tools == 0`. Otherwise use the model's stated kind, or
   the counters (`data`/`mixed`). Update `test_chat_engine_loop.py:576` and add a case with
   data lookups plus `unsupported:true`, which should give `data` with no unsupported callout.
2. **Separate "unsupported" from "answered with limits".** Add a header field such as
   `"limits": ["<what could not be covered>"]`, or a new `TurnNotice` kind `limited`
   (info tone, title "Answered with limits"). When data tools ran and the model sets
   `unsupported`, downgrade it to `limited`. Keep `unsupported` for "no tool reads this
   domain". The UI gets a quiet info line, not a refusal callout.
3. **Notice copy follows the links.** Use "…Use the linked console page instead." only when
   `console_links` is non-empty. Otherwise use "Chat has no lookup for this data yet."
   (`chat_protocol.py:904`, `chat.py:2060`).
4. **Unknown tool inputs become visible.** Either `extra="forbid"`, or echo the ignored keys
   in the observation as `ignored_inputs: ["group_by"]` (`common.py:122`), so the model never
   believes a grouping ran.

### Prompt (`backend/app/agents/prompts.py`)
5. Replace `:823` and `:855-857` with: *"Answer every part your lookups can read. If part of
   the question is beyond them (a longer window than a lookup allows, a grouping no lookup
   offers), answer the rest, say in one sentence what is missing and why, and keep
   `unsupported` false. Set `unsupported: true` only when the WHOLE question is about data no
   listed lookup reads (users, roles, sessions, jobs, notifications, dashboards, secrets) and
   you ran no data lookup. Never set answer_kind to product_help when you used data lookups."*
6. Add: *"Do not ask a clarifying question when a reasonable default exists: pick it, state
   it, and offer the alternative as a follow-up."* Add a report recipe: *"performance, posture
   or 'how are we doing' reports: run soc_metrics posture, trends, timing and noise_funnel (and
   case_mix) in parallel with the same window and put them in a report block (template
   posture)."* Add: *"'lifetime', 'all time' and 'ever' mean no window on lookups that accept
   it; otherwise use the longest window the lookup allows and say so."*
7. Fix `:915`. Do not say "lookups default to the last 24 hours". Say which lookups default
   to 24 h and which to all time.
8. State the bounds in each signature (`metrics.py:276`, `cases.py:222`): for example
   `window_hours? (1..N, omit = all time)` and `limit (≤50)`. Also list the groupings each tool
   supports, so the model chooses rather than guesses.

### Tools (backend/app/agents/chat_tools)
9. **New `case_stats` (or `search_cases.group_by`).** Exact counts over the whole case store:
   `group_by ∈ {created_month, created_week, created_day, severity, status, verdict,
   priority, assignee, closed_by, rule, source}`, plus the filters of `search_cases`
   (`status_group`, window or all time). Use store-native aggregation (ES `date_histogram` and
   `terms`, SQL `GROUP BY`) so 253 or 25,000 cases give exact buckets with no sample and no
   5,000 cap. Artifacts: `series` (bar by month) and `categories`. This fixes screenshot 4 and
   probe rows 2, 4, 16, 17, 21, 23.
10. **Lifetime metrics.** Let `soc_metrics`, `search_cases` and `cost_usage` accept all time
    (`window_hours` omitted → all, or `window="all"`) up to retention. Clamp out-of-range values
    instead of failing (`metrics.py:178`, `common.py:158`). Add `interval=day|week|month` for
    `trends`/`timing` so "MTTR trend" and "month over month" work over 90 days or more. Remove
    the 30-day cap where the engine can compute it (the operator asked for no limits).
11. **Remove the truncation sources the operator objected to.** Page through the full case
    store, or use aggregations, instead of `CASE_SCAN_LIMIT=5_000` for metrics. Stop dividing
    `observation_chars` by the call count (or raise the default substantially) so aggregate
    observations are not `_shrunk_for_prompt`. Aggregates are small; raw rows are not.
12. **`search_cases` KPI.** When `status_group=active` (or `status` is an open status), set
    `open = count` with `bound = not exact` (`cases.py:307-314`).
13. **Human window labels** ("last 30 days", not "last 720h") in `window_label`.

### Demo planner (`backend/app/engine/demo_chat.py`), so Demo matches the fixed production behaviour
14. `_CHANGE_RE` (`:917`) and `classify` (`:1299`): a create/make/build/generate/give verb
    followed by report, brief, summary, chart, graph, table, list, breakdown or export is a
    report or data request, not a write.
15. `_final_generic` (`:4110`): set `unsupported` only for the `unsupported` intent (or zero
    data tools granted). A failed or not-found lookup is a data answer with a "partial" or
    "not found" note.
16. `_hours_from` (`:1014-1040`): parse "this month", "this year", "quarter", "N months",
    "90 days", "all time", "lifetime" and "ever". Do not shorten windows silently; when a tool
    bound applies, the final says so.
17. Add intents for month or field breakdowns (use `case_stats`) and for
    "MTTR/MTTA/MTTD trend" (`soc_metrics timing`). Stop appending an unrelated 24 h
    `case_mix` to case lists.

### UI (webui/src/soc/chat/message)
18. `Message.tsx:286`: show "Product help" only when `answer_kind === 'product_help'` **and**
    no step ran a data tool (`steps.some(s => s.kind==='tool' && !['app_help','app_status'].includes(s.tool))`).
    This also protects older stored turns.
19. `NoticeCallout.tsx:40`: retitle `unsupported` to "Chat can't read this data", and add the
    `limited` kind with the title "Answered with limits" and info tone, not a refusal.
20. KPI tile: do not clip "≥10 in the returned page" to "≥…". Wrap the context line instead
    (screenshot 4).

### How competitors handle this (from public product docs; not re-verified in this pass)
Google SecOps Gemini, Palo Alto Cortex XSIAM/XDR copilot (XQL `comp count() by … | bin
_time span=…`), Microsoft Security Copilot (promptbooks) and Amazon Q / Security Lake all turn
natural language into a native query with an explicit time range **and an aggregation**
(group by field or time bucket). They show the generated query and the window actually used.
When retention or a quota applies, they answer within it and say so. They do not refuse. The
fixes in items 5, 9 and 10 bring chat to the same pattern: express the aggregation, answer
best-effort, and state the limit.
