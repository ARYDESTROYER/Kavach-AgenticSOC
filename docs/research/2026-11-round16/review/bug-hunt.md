# Round 16 bug hunt: the confirmed bugs

The bug-hunt workflow ran eight finders by area at `3cd362c`: the engine (11 candidates), the backend API (3), authentication and security (11), three live Console walkthroughs on the seeded Demo (7, 11 and 15), data correctness (13), and accessibility and phone (11). Every candidate was checked by an independent skeptic, who tried to refute it, reproduced it where possible and wrote the smallest correct fix. 81 of the 82 candidates were confirmed (one Console finding was rejected). Six confirmed findings are duplicates of another and are merged into it, so 75 fixes land (Round 16 SPEC D12).

Ids B01 to B81 follow the order of the workflow's output and are stable. The Round 16 SPEC Appendix A allocates each one to a work package. Evidence, failure scenario and both fixes are reproduced as the workflow wrote them; only paths into the session scratchpad are shortened to `<scratchpad>/`, and the skeptic's full reasoning is summarised by its first paragraph. Line numbers are as found at `3cd362c` and drift as packages land. Where the SPEC replaces or tightens a step of a minimal fix (B09, B11, B13, B15, B16, B19, B20, B23, B24, B45, B48, B62; the later ones after the SPEC's code review, SPEC Appendix C), the SPEC wins.

## Summary

| Id | Severity | Area | Title | Owning package | Merged into |
|---|---|---|---|---|---|
| B01 | medium | RBAC: case and settings reads | Older case and settings GET routes skip their read grant, so a role denied cases:read still gets case data | WP15A | - |
| B02 | low | API validation: relative windows | An out-of-range relative window on /api/cases and /api/scans/notifications answers 500 | WP15C | - |
| B03 | low | Chat feedback summary time filter | GET /api/chat/feedback/summary compares `since` as text, so a since value with a zone offset filters the wrong ratings | WP15C | - |
| B04 | high | Pipeline re-entry on a decided case (#3, #4) | register_candidate on a signature whose open case is already decided wipes the verdict and decision, then the follow-up investigate re-bills and can re-decide (auto-close) it | WP15B | - |
| B05 | high | Ingest overrides a person's move | The agent auto-closes an un-investigated candidate that a person escalated, acknowledged or put on hold, on the next tick that carries a new event | WP15B | - |
| B06 | high | Drain and job risk input | state.cluster_for_case (used by the deferred-candidate drain and the bulk reinvestigate job) fabricates member timestamps and rules, inflating risk and changing decide()'s outcome; aged-out pull cases fail in the job but not in the route | WP15B | - |
| B07 | medium | Correlation look-back windows | The correlation look-back ignores rule-catalog (Rules editor) correlation windows, so a configured threshold over a longer window can never fire | WP15B | - |
| B08 | medium | Automation lost update | Post-decision threshold automation saves a stale in-memory case after awaiting notification I/O, overwriting a person's concurrent work | WP15B | - |
| B09 | medium | Rebuild carry-over | Every rebuild of a case drops related_case_ids, cross_source_cluster_id, source_breakdown and automation_actions | WP15B | - |
| B10 | medium | Pipeline failure path duplicate (#4) | A transient case-store read failure at the start of a run mints a second open case for the same signature (#4) | WP15B | - |
| B11 | medium | Deferred drain scale (#4) | The deferred-candidate drain re-scans every OPEN case each tick, and on Elasticsearch it can never reach candidates past the first 10,000 | WP15B | - |
| B12 | low | Failed-run cost (#6 presentation) | A failed run resets the case's token_cost to $0 and drops the run's partial spend | WP15B | - |
| B13 | medium | Risk inputs not recorded | The risk score cannot be cross-verified: the factor inputs are not stored, and the Console pairs the post-attach member count with a volume factor computed from a different count | WP10 | - |
| B14 | low | Bulk reinvestigate job result | A bulk reinvestigate job reports an item as succeeded when the investigation failed | WP15B | - |
| B15 | high | SSO mints a Super admin | A settings:manage holder can mint a stored Super admin through SSO, bypassing the Round 15 Super-admin-only boundary | WP15A | - |
| B16 | high | SSO cross-provider linking | SSO links any account provisioned by another provider when the email matches (cross-provider account takeover, Super admins included) | WP15A | - |
| B17 | medium | MFA enrolment replacement | An existing MFA factor can be replaced from a bare session without proving the old factor or re-authenticating | WP15A | - |
| B18 | medium | Password hashing on the event loop | Password hashing runs on the event loop: unauthenticated logins and wrong MFA codes stall every request | WP15A | - |
| B19 | medium | MFA attempt bound | MFA verification has no attempt bound, and a pending token stays reusable for its whole 5 minutes | WP15A | - |
| B20 | medium | Forced password change | must_change_password is not enforced by the server, and the seeded Admin/Admin@123 is not even flagged (contradicts USAGE.md) | WP15A | - |
| B21 | low | Sessions after a password change | Changing or resetting a password leaves every existing session signed in | WP15A | - |
| B22 | low | Session IP from a forwarded header | The session registry records a client-chosen IP (first X-Forwarded-For entry) in the session list and new-device notices | WP15A | - |
| B23 | low | MFA code single use | A recovery code or TOTP code can be redeemed twice by concurrent requests | WP15A | - |
| B24 | low | Refresh-token rotation unreachable | Refresh-token rotation is never reachable: no sign-in issues a refresh token | WP15A | - |
| B25 | low | Sign-in SSO error text | The sign-in page shows arbitrary attacker text from ?sso_error= | WP04 | - |
| B26 | high | SLA response clock on auto-closed cases | SLA response clock keeps running on cases the agent closed, so every auto-close eventually counts as a permanent SLA breach | WP15C | - |
| B27 | high | Case auto-close policy text | Case detail reads the deprecated prefs.fp_auto_close, so the facts rail and Investigation tab state the wrong auto-close policy | WP03 | - |
| B28 | medium | Take action menu items | Take action → Change owner and Edit tags open and immediately close (dead menu items) | WP03 | - |
| B29 | low | KPI drill-down Source column | KPI drill-down 'Source' column (and CSV) is blank for every alert-sourced case | WP12 | - |
| B30 | low | Screenshot history text | Deleting or adding a screenshot writes raw machine text to case history, without the caption or filename the dialog promises | WP14 | - |
| B31 | low | Screenshot upload over the limit | Choosing more screenshots than the remaining room silently drops the extras | WP14 | - |
| B32 | low | SLA countdown rounding | SLA countdown rounds to the nearest hour or day, overstating the time left | WP11 | - |
| B33 | high | LEEF push event ids | LEEF push events of the same event type collapse to one id, so distinct events are dropped | WP15B | - |
| B34 | medium | Rule preview in Demo Mode | Rule 'Test and preview' ignores Demo Mode: it reads the real tenant sources | WP15D | - |
| B35 | medium | Demo precedent corpus alarm | Seeded Demo raises two CRITICAL agent-health alerts because the demo precedent corpus is never projected | WP15D | - |
| B36 | low | Approvals invented confidence | Automation proposals show a made-up '50% confidence' labelled as the agent's confidence | WP15E | - |
| B37 | low | Approvals decided card | An approved proposal shows a 'Retry approval' button and still says 'Expires in 1mo' | WP15E | - |
| B38 | low | Chat export sources | Conversation export claims 'Sources queried: Splunk…' for answers that queried no log source | WP15G | - |
| B39 | low | Shift brief created time | Shift-brief 'Needs attention' list has no created time, so its 'Created (UTC)' export column is always blank | WP15C | - |
| B40 | low | Chat delete dialog text | 'Delete conversation?' always says 'Its report stays in Reports', even with no report | WP15G | - |
| B41 | low | Demo chat attention question | Demo chat answers a free-text 'need attention first' question with closed, low-risk false positives | WP15D | - |
| B42 | low | Chat citation case number | Chat citation chip shows the internal case id instead of the case number | WP15G | - |
| B43 | high | Wizard writes Demo sources | Setup wizard in Demo Mode writes demo sources into the live source configuration (Make primary / Edit) | WP15E | - |
| B44 | medium | Settings draft lost on Back | Browser Back (or a typed hash) silently discards an unsaved Settings draft | WP15E | - |
| B45 | medium | Two default theme controls | Two 'organization default theme' controls store different values and show contradictory state | WP15E | - |
| B46 | medium | Make primary on a push source | Make primary on a push/queue source reports success but the server silently drops it | WP15E | - |
| B47 | medium | Demo agent health alarm | Fresh Demo Mode raises two Critical 'agent health' alarms (precedent corpus starved) on the bell and Effectiveness | WP15D | B35 |
| B48 | low | Demo cost without ledger rows | Demo cost data is incoherent: cases carry AI spend the cost ledger never records, and the simulated rate contradicts the model price | WP15D | - |
| B49 | low | Data export in Demo Mode | Data export 'Build ZIP in background' is enabled in Demo Mode and fails with a raw 409 | WP15E | - |
| B50 | low | Branding default accents | Branding editor shows wrong default accents (violet/teal) while the Console's real defaults are blue/indigo | WP04 | - |
| B51 | low | Settings coherence validation | Settings accepts incoherent or unparseable values without validation (SLA respond > resolve, unknown timezone, free-text lookback) | WP15A | - |
| B52 | low | Update control off PostgreSQL | Top bar offers 'Enable updates' on deployments that can never enable one-click updates | WP05 | - |
| B53 | low | Inbox preferences width | Notification preferences table is clipped at 1440 px (Telegram column cut off) | WP15E | - |
| B54 | low | Help Center Stable link | Help Center says the Stable site does not exist yet, though Stable documentation was published | WP05 | - |
| B55 | low | Sessions activity labels | Sessions > Activity shows raw event ids ('User.deleted', 'Auth.login', 'Team.viewed') | WP15A | - |
| B56 | low | Team person sheet audit link | Team activity person sheet 'Open in Audit log' drops the window | WP15E | - |
| B57 | low | Permission resource names | Permission resource names shown as raw tokens ('Rag', 'Inapp') | WP15E | - |
| B58 | high | SLA attainment falls over time | SLA response clock never stops for agent auto-closed cases, so SLA attainment falls over time with no change to any case | WP15C | B26 |
| B59 | high | Operational MTTR | Metrics > Operational MTTR uses updated_at − created_at over 'closed' only, so any later edit inflates it (10m to 6h 41m after one comment) | WP15C | - |
| B60 | medium | Standup SLA aging | Standup and SOC operations 'SLA breached' use the unpersisted priority_level (always 120-min default, 'unprioritized') and ignore acknowledgement | WP15C | - |
| B61 | medium | Demo analyst classification | Demo seed: analyst closes carry no classification entry, so 17 human true-positive closes read 'Outcome not recorded' and Executive 'Confirmed threats' shows 1 | WP15D | - |
| B62 | medium | Demo risk factors | Demo risk factors do not reproduce from the case's own inputs (same Volume 72 for 3 and 6 alerts; asset criticality 47 while the impact chip says 0) | WP15D (Demo hunk of B13) | B13 |
| B63 | medium | Timeline decision stage | Timeline 'Decision' stage takes its time from updated_at and re-derives the decision from today's policy instead of the recorded decision | WP10 | - |
| B64 | medium | Noise flow share | Overview noise flow prints 'Cases opened 56 · 147%' of clusters when the alert counters cover only part of the window | WP12 | - |
| B65 | medium | Demo health banner | Demo precedent corpus is seeded before the demo cases exist, so every page shows a false 'Agent health needs attention' banner | WP15D | B35 |
| B66 | low | Overview Respond copy | Overview 'Respond' copy says assignment counts and calls the p50 a mean, but the clock ignores assignment | WP12 | - |
| B67 | low | Overview closed label | Overview Latest cases labels status 'closed' as 'Resolved' | WP12 | - |
| B68 | low | Top rules 'more' count | Top detection rules 'N more rules' counts rules with zero cases in the window | WP15C | - |
| B69 | low | Demo case cost | Demo per-case 'Investigation cost' has no ledger rows behind it | WP15D | B48 |
| B70 | low | Case read routes | Case rationale, trace and export routes skip the cases:read check (outside the data-correctness area) | WP15A | B01 |
| B71 | high | Skip link | The "Skip to main content" link takes keyboard users away from the page they are on, to Overview | WP15F | - |
| B72 | medium | Audit list reflow | Audit log list cuts off the Actor and Summary columns between 640 and about 1000 px; the page scrolls sideways near 768 px | WP15F | - |
| B73 | medium | Phone navigation focus | The phone navigation sheet drops focus to <body> when it closes, and after picking a destination | WP15F | - |
| B74 | medium | Sticky column hides focus | A sticky first column hides the focused control in DataTable on phones (WCAG 2.2 SC 2.4.11) | WP15F | - |
| B75 | low | Popover dialog names | Popover dialogs have no accessible name (axe aria-dialog-name, serious) | WP15F | - |
| B76 | low | Palette separators | The command palette listbox contains role=separator children (axe aria-required-children, critical) | WP15F | - |
| B77 | low | Runbooks focus | Opening a runbook, or going back to the library, leaves focus on <body> with no announcement | WP15F | - |
| B78 | low | Scroll region focus | Scroll regions with no focusable content: CodeBlock pre and the bare table wrapper (axe scrollable-region-focusable) | WP15F | - |
| B79 | low | Phone audit time | Phone Audit list cuts every timestamp's seconds ("24 Nov 20:57:…") | WP15F | - |
| B80 | low | Untrusted caption clipped | Case evidence caption "Untrusted source data" is clipped mid-word with no ellipsis at 390 and 768 | WP15F | - |
| B81 | low | Phone input zoom | Phone text inputs are 13 px, which triggers iOS Safari's zoom on focus (not reproduced: no WebKit here) | WP15F | - |

## Findings

### B01. Older case and settings GET routes skip their read grant, so a role denied cases:read still gets case data

- Area: backend-api / RBAC
- Severity: medium
- Location: `backend/app/api/routes.py:8191`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

These GET handlers declare no require_permission and do no in-body _enforce. They are protected only by the router-wide require_auth: case_export (routes.py:8191), case_trace (8498), case_rationale (8517), scans (8579), scan_notifications (8591), the standup routes (8603+), get_settings (1769), and get_case_activity / get_case_thread / get_case_tasks (routes_cases_collab.py:411, 461, 708). The sibling GET /api/cases/{id} and GET /api/cases do enforce cases:read. Reproduction (<scratchpad>/probe/rbac_deny_case.py): RBAC on; user t1 is analyst_tier1 with prefs.rbac.denies={'analyst_tier1': {'cases':['read'], 'settings':['read']}}. /api/account/permissions then shows cases=['write','assign','comment']. Results: GET /api/cases/case-secret-1 -> 403 'permission denied: cases:read'; GET /api/cases -> 403; GET /api/settings/schema -> 403. But GET /api/cases/case-secret-1/export?format=json -> 200 (the full Case JSON); /rationale -> 200 (verdict, confidence, reasoning); /trace, /activity, /thread, /tasks -> 200; GET /api/scans -> 200 (full Case documents); GET /api/settings -> 200 (the whole Preferences dump). No Access denied row is written. With every grant stripped from a role (rbac.roles override, rbac_gets.py), the same routes plus /api/standup, /api/standup/report, /api/llm/models and /api/personas still answer 200.

**Failure scenario.**

An operator removes cases:read from a role, or builds a restricted role with rbac.denies or rbac.roles overrides (for example a billing viewer, or an analyst who must not see a sensitive case set). The Console hides the case pages, but any member of that role can still pull every case through /api/scans and /api/cases/{id}/export. They can read each case's rationale, audit-derived activity, thread and tasks, and the full settings document. Nothing in the audit log shows a denial. test_route_auth_coverage.py checks only non-GET routes, so CI never flags this.

**Proposed fix.**

Add Depends(require_permission('cases','read')) to case_export, case_trace, case_rationale, scans, scan_notifications, the standup reads and the three collab GETs. Add require_permission('settings','read') to GET /api/settings, as /settings/schema already has. Extend test_route_auth_coverage.py so every GET route under /api must declare a grant or be on a reviewed GET allowlist (health, setup/status, auth/me, account/*, prefs/user, notifications/inbox and other self-service routes).

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. The defect is real.

**Skeptic's minimal fix.**

Add `_=Depends(require_permission("cases", "read"))` to these routes:
- In backend/app/api/routes.py: `case_export` (8191), `case_trace` (8498), `case_rationale` (8517), `scans` (8579), `scan_notifications` (8591) and the standup GETs (8603 and following).
- In backend/app/api/routes_cases_collab.py: `get_case_activity` (411), `get_case_thread` (461) and `get_case_tasks` (708).

Add `_=Depends(require_permission("settings", "read"))` to `get_settings` (routes.py:1769), as `/settings/schema` already has.

Then extend backend/tests/test_route_auth_coverage.py with a GET-route rule: every `/api` GET must declare a `require_permission` dependency or be on a reviewed allowlist of self-service and public reads (health, setup/status, auth/me, account/*, prefs/user, the notifications inbox, branding). Add a regression test that removes cases:read with a custom-role deny and expects 403 from export, rationale, trace, activity, thread, tasks and scans.

Separately, review `/api/llm/models` and `/api/personas`, which answered 200 even with every grant stripped from the role. They need whatever grant the Console page that shows them uses.

### B02. An out-of-range relative window on /api/cases and /api/scans/notifications answers 500

- Area: backend-api / validation
- Severity: low
- Location: `backend/app/api/routes.py:8595`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

GET /api/cases?from=now-999999d, ?to=now-9999999d or ?from=now+99999999d all answer 500 Internal Server Error, with or without sort_field. Traceback: routes.py:7085 list_cases -> stores/cases.py:255 list_window -> utils.relative_to_iso_utc_strict -> utils.millis_to_iso_utc:314 `datetime(1970,1,1,tzinfo=utc)+timedelta(milliseconds=...)` -> OverflowError: date value out of range. GET /api/scans/notifications?since=now-9999999d also answers 500: routes.py:8595 -> _millis_to_iso:8721 `datetime.fromtimestamp(...)` -> ValueError: year -25353 is out of range. The same values sent with review=, q= or rule= (the queue-scan branch) answer normally, and GET /api/audit and every Round 12-15 window route reject them cleanly (fuzz scripts fuzz_get.py, fuzz_windows.py and cases_params.py in the probe scratchpad).

**Failure scenario.**

A client or a hand-edited deep link sends a large relative window, such as now-1000000d meant as 'all time'. The request fails with an unhandled 500 instead of the coded 400 the route gives other bad windows, and an error is logged per request.

**Proposed fix.**

In relative_to_iso_utc_strict / millis_to_iso_utc, and in routes._millis_to_iso, catch OverflowError and ValueError and raise the route's 400 'bad window' (or clamp to datetime.min/max as window_bounds_proven expects). Add the overflow values to the list_cases and scan_notifications parameter tests.

**Skeptic's verdict (first paragraph).**

I reproduced it at 3cd362c. I used a scratch TestClient script with the same lifespan fixture as tests/test_case_window_store.py, pointed at InMemoryESClient: <scratchpad>/repro_overflow.py.

**Skeptic's minimal fix.**

Make the two ISO conversions total and clamp to the representable datetime range:

1. In backend/app/utils.py, have millis_to_iso_utc, or relative_to_iso_utc_strict, catch (OverflowError, ValueError). Return `datetime.min.replace(tzinfo=timezone.utc).isoformat()` ('0001-01-01T00:00:00+00:00') when millis < 0, and `datetime.max.replace(tzinfo=timezone.utc).isoformat()` otherwise.
   - A clamped bound still sorts correctly against every stored YYYY-... created_at under lexicographic comparison.
   - It is the same window over every representable timestamp, so window_total_exact=True stays honest.
   - The ES list_window and the SQL repository (stores/sql/repositories.py:390) are both fixed through this one helper.
2. In backend/app/api/routes.py, apply the same clamp in _millis_to_iso (around line 8718), which scan_notifications uses. Alternatively, route it through the fixed utils helper.
3. Add now-999999d, to=now-9999999d and now+99999999d cases to the list_cases and scan_notifications route tests, asserting a 200 response.

Returning None instead of clamping would also stop the 500, but it would mark the window inexact without need.

### B03. GET /api/chat/feedback/summary compares `since` as text, so a since value with a zone offset filters the wrong ratings

- Area: backend-api / time zones
- Severity: low
- Location: `backend/app/stores/chat_feedback.py:229`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

routes_chat_library.py:195-199 accepts since matching ^\d{4}-\d{2}-\d{2}[T0-9:.+\-Z]*$, which allows 'Z' and '+hh:mm' offsets. ChatFeedbackStore.breakdown then filters with `if since and entry.updated_at < since` (and the same for until). That is a string comparison against stored iso_now() values like '2026-11-24T10:30:00.123456+00:00'. Checked: with since='2026-11-24T12:00:00+05:30' (06:30Z), a rating made at 10:30Z is EXCLUDED, although it is four hours after since. With since='2026-11-24T10:00:00Z', a rating at 10:00:00.5Z is also excluded, because '.' sorts before 'Z'.

**Failure scenario.**

An API client (no Console caller today) asks for the feedback summary since a local-time instant with an offset, or a 'Z' instant. Up and down counts drop ratings that fall inside the window, or keep ones outside it, depending on the offset sign, and nothing in the response says so.

**Proposed fix.**

Parse since and until once (utils.parse_es_timestamp or datetime.fromisoformat), normalise to UTC and compare datetimes, parsing entry.updated_at the same way. Answer 422 when since does not parse. Or restrict the pattern to the exact +00:00 spelling the store writes.

**Skeptic's verdict (first paragraph).**

I reproduced the defect. The route `backend/app/api/routes_chat_library.py:195-199` accepts `since` matching `^\d{4}-\d{2}-\d{2}[T0-9:.+\-Z]*$`, so `Z`, `+hh:mm` and `-hh:mm` spellings all pass. `ChatFeedbackStore.breakdown` (`backend/app/stores/chat_feedback.py:229-232`) then filters with `entry.updated_at < since` and `entry.updated_at > until`. Those are plain string comparisons against the stored `iso_now()` values, which look like `2026-11-24T21:32:17.585277+00:00`.

**Skeptic's minimal fix.**

In `ChatFeedbackStore.breakdown`, compare instants, not strings.

1. Add a helper, `_instant(value)`:
   - It calls `datetime.fromisoformat(value)`, which accepts `Z` on Python 3.11.
   - It sets `tzinfo=timezone.utc` when the result is naive, which covers a date-only value.
   - It returns `dt.astimezone(timezone.utc)`.
2. Parse `since` and `until` once at the top of `breakdown`, and raise `ValueError` if either does not parse.
3. For each entry, use `_instant(entry.updated_at)`. Skip entries whose stamp does not parse, or count them, but say which in a comment. Then filter with `if since_dt and at < since_dt` and `if until_dt and at > until_dt`.
4. In `chat_feedback_summary` (`routes_chat_library.py`), catch the `ValueError` and answer 422, for example `_http(422, "invalid_since", "since must be an ISO-8601 instant.")`.

The chat tool caller passes UTC isoformat strings, so it keeps working unchanged. Add a regression test that records a rating and checks `breakdown` with a `+05:30`, a `-05:00` and a `Z` value of `since`.

### B04. register_candidate on a signature whose open case is already decided wipes the verdict and decision, then the follow-up investigate re-bills and can re-decide (auto-close) it

- Area: engine/pipeline (#3, #4, P1 verdict stability)
- Severity: high
- Location: `backend/app/agents/pipeline.py:1590`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_register_candidate_locked (pipeline.py:1550-1626) finds the open case (line 1554) and, whenever no analyst policy matches, rebuilds it as a fresh Case(verdict=None, status=CaseStatus.OPEN, ...) (lines 1590-1591) with no evidence, mitre, confidence, recommended_action, decision_by or escalation_level, then saves it. The function assumes existing is a candidate, but two callers invoke it on any open case: state._reenter_detections (state.py:2143-2147, the Batch event-detection re-entry, whose own docstring says the cluster should 'attach to any open case for that signature') and DemoStack.route_event_batch (demo_runtime.py:760-761, every Demo funnel survivor, and funnel candidates for the same entity and source recur across ticks). Both then call investigate_cluster without force. Because verdict is now None, the P1 'no material change' guard (pipeline.py:900-925) no longer applies, so the case is investigated and decided again. Repro script <scratchpad>/repro_register.py prints: 'after investigate: ... escalated Verdict.TRUE_POSITIVE 0.9 DecisionBy.SYSTEM [T1110]' and then 'after register_candidate: True open None 0.0 None [] Candidate cluster awaiting investigation. ann 1'.

**Failure scenario.**

Batch event detection (or Demo Mode) confirms a detection for entity E on source S, where an open case already exists that the realtime path investigated as TRUE_POSITIVE and escalated. register_candidate turns it back into an OPEN candidate with verdict None: the TP verdict, MITRE, evidence and escalation disappear from the queue. investigate_cluster then runs the LLM again (a second spend), and a FALSE_POSITIVE answer at 0.85 or higher with risk 30 or lower auto-closes the case the analyst was handling. A Batch re-entry retry after a partial failure replays this on every cluster that already succeeded.

**Proposed fix.**

Make register_candidate idempotent on an existing case. When find_open_case_for_cluster returns a case, merge the events with attach_cluster and return it without rebuilding (that is what the realtime handle_clusters does). Rebuild only when existing is None or existing.verdict is None and the case was not moved by a person. In _reenter_detections and route_event_batch, skip investigate_cluster when the open case already has a verdict, as handle_clusters does (attach only). Add a regression test: re-entry on a decided, escalated case keeps its verdict, status and escalation_level and makes no model call.

**Skeptic's verdict (first paragraph).**

Confirmed at HEAD 3cd362c. The working tree was left clean.

**Skeptic's minimal fix.**

Apply the realtime attach-only rule in both re-entry callers and make register_candidate safe on its own:

1. In `_register_candidate_locked` (pipeline.py), after the `_close_by_analyst_policy` check, add:
   ```python
   if existing is not None and (existing.verdict is not None or existing.decision_by == DecisionBy.ANALYST):
       from ..engine.ingest import attach_cluster
       await attach_cluster(self._cases, existing, cluster)
       return existing
   ```
   The import is lazy to avoid an import cycle. A decided case, or one a person moved, is never rebuilt as a candidate.

2. In `state._reenter_detections` (state.py:2143) and `DemoStack.route_event_batch` (demo_runtime.py:760), keep the case returned by register_candidate. Then:
   ```python
   case = await pipeline.register_candidate(...)
   if case.verdict is not None or case.decision_by == DecisionBy.ANALYST:
       continue  # attach-only, the same as ingest.handle_clusters:348-351
   await pipeline.investigate_cluster(...)
   ```

3. Add regression tests:
   - Re-entry on an escalated TRUE_POSITIVE case keeps verdict, status, escalation_level, confidence and mitre, and makes no model call.
   - Re-entry on a case an analyst moved to INVESTIGATING keeps its status and is never auto-closed.

`decide()` is untouched.

### B05. The agent auto-closes an un-investigated candidate that a person escalated, acknowledged or put on hold, on the next tick that carries a new event

- Area: engine/ingest handle_clusters + pipeline apply() (person vs run)
- Severity: high
- Location: `backend/app/engine/ingest.py:348`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

handle_clusters treats only a case with a verdict as attach-only (ingest.py:348). A candidate (verdict None) in ANY open status (ESCALATED, INVESTIGATING, ON_HOLD, a reopened policy close) falls through to the eligibility gate and is forwarded to _investigate_cluster_locked (ingest.py:404-424). Every lifecycle action stamps decision_by=ANALYST (routes.py:7699). The pipeline's analyst-policy path refuses to override that (pipeline.py:1400-1404, whose comment describes exactly this harm). The investigation path has no such guard: _assemble_case carries the person's status only as apply()'s previous status (pipeline.py:1685), and CaseManager.apply (pipeline.py:1224) replaces it with decide()'s result. _carry_case_work deliberately drops escalation_level and decision_by. Repro script <scratchpad>/repro_escalated_candidate.py: a cap-deferred alert candidate is escalated by 'ann' (escalation_level 2, assigned). One handle_clusters call with a new event and a FALSE_POSITIVE 0.95 verdict prints 'after tick: closed DecisionBy.AGENT 0 'ann' 7.41 [('open','escalated','ann'), ('escalated','closed','agent')]'.

**Failure scenario.**

A Critical alert is deferred by the per-tick cap (or by auto-correlate off, or by the risk floor), and an analyst escalates and takes it. One more event for the same entity arrives. The cluster is now eligible, the model calls it a false positive, and decide() auto-closes the case as the agent while the analyst's escalation level resets to 0. It leaves the analyst's queue, gets an objection window, and may even be picked by the auto-close review sampler. Nobody asked for an investigation.

**Proposed fix.**

In handle_clusters, treat a candidate whose status is not OPEN/NEW, or whose decision_by is ANALYST, as attach-only, the same rule the policy path uses; it can still be reinvestigated with force. Alternatively, in _investigate_cluster_run (non-force runs), skip the rebuild when existing.decision_by == ANALYST. decide() and apply() stay unchanged. Add a test with the repro above.

**Skeptic's verdict (first paragraph).**

I tried to refute it and could not. I reproduced it through the supported analyst path.

**Skeptic's minimal fix.**

Use the policy path's test (the case carries `decision_by == ANALYST`), not a status test, so a reopened or resumed OPEN case is covered too. Leave `decide()` and `apply()` unchanged.

1. `backend/app/engine/ingest.py:348`: make a candidate a person has acted on attach-only:
```python
if existing is not None and (
    existing.verdict is not None
    or existing.decision_by == DecisionBy.ANALYST
):
    await attach_cluster(cases, existing, cluster)
    stats["attached"] += 1
    continue
```
Import `DecisionBy` from `..constants`. The case then uses no cap slot and is not counted as investigated.

2. Add the same guard in `InvestigationPipeline._investigate_cluster_run`, right after the analyst-policy check and before P1. This covers `poller_manager._drain_deferred` and the event-detection path in `state.py:2145`:
```python
if (existing is not None and not force and existing.verdict is None
        and existing.decision_by == DecisionBy.ANALYST):
    await attach_cluster(self._cases, existing, cluster)  # from ..engine.ingest (no import cycle)
    await self._audit.record(action_type=ActionType.DECISION, surface=source_surface.value,
        actor="pipeline", case_id=case_id,
        result_summary="a person owns this candidate; events attached, not investigated")
    return existing
```
`force=True` (Investigate, Reinvestigate, the reinvestigate job) still runs, so a person can always ask for the AI.

3. Optional, for clarity: in `_drain_deferred`, add `or case.decision_by == DecisionBy.ANALYST` to the skip condition.

4. Add a regression test: register a candidate; apply escalate, acknowledge or hold through `_perform_case_action`; call `handle_clusters` with a new event and a FALSE_POSITIVE 0.95 mock. Assert that the status, `decision_by=ANALYST`, `escalation_level` and assignee are unchanged, the new event is attached, and no model call was made.

### B06. state.cluster_for_case (used by the deferred-candidate drain and the bulk reinvestigate job) fabricates member timestamps and rules, inflating risk and changing decide()'s outcome; aged-out pull cases fail in the job but not in the route

- Area: engine/poller_manager drain + jobs._case_reinvestigate (deterministic risk input)
- Severity: high
- Location: `backend/app/state.py:1644`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

For a push or deleted source, _automation_cluster_for_case (state.py:1638-1656) rebuilds every member event with timestamp_millis=case.first_seen_millis and rule=case.rule_ids[0]. The window collapses to 0 s (compute_risk floors it to 1 s), so velocity saturates at 100 for 3 or more events and diversity drops to one rule. The route's reconstruct_cluster_from_case (case_cluster.py) spreads the events over the stored trigger window and cycles the stored rules, and documents that this is so 'the deterministic risk model see[s] faithful inputs'. Measured with the default weights for 5 events over 1 hour on 3 rules: original 20.56, state.cluster_for_case 34.39 (velocity 100, diversity 20), route reconstruction 20.61. The default FP auto-close bar is max_risk_score 30, so the same verdict auto-closes in one path and routes to a person in the other. Callers: PollerManager._drain_deferred (poller_manager.py:499) and JobRunner._case_reinvestigate (jobs.py:712). For a pull case whose events aged out, the state version returns None (no entity-widening fallback and no stored reconstruction), so the job item fails with 'This case has no stored evidence to reinvestigate.' while POST /api/cases/{id}/reinvestigate (routes.py:8391, allow_stored_reconstruction=True) succeeds on the same case.

**Failure scenario.**

A push (webhook or syslog) alert is deferred by the per-batch cap. On the next manager tick _drain_deferred rebuilds it with identical timestamps: risk rises from 21 to 34, the FALSE_POSITIVE verdict no longer clears max_risk 30, and the case lands on the analyst queue instead of auto-closing. The case's risk breakdown then shows Velocity 100 for 5 events spread over an hour. Bulk 'Reinvestigate' over older pull cases fails item by item while the single-case button works.

**Proposed fix.**

Delete the hand-rolled reconstruction and have state.cluster_for_case delegate to engine.case_cluster.cluster_for_case(case, es=..., log_source=..., prefs=self.execution_prefs, query_source=self.active_source_for_id(case.source_id), allow_stored_reconstruction=True), as the routes do. Pin a test proving the drain, the job and the route compute the same risk for the same stored case.

**Skeptic's verdict (first paragraph).**

I tried to refute it and could not. The report holds, and I reproduced it.

**Skeptic's minimal fix.**

In backend/app/state.py, replace the body of `_automation_cluster_for_case`/`cluster_for_case` so that it delegates to the shared engine helper with the real stack's dependencies:

```python
async def cluster_for_case(self, case):
    from .engine.case_cluster import cluster_for_case as _engine_cluster_for_case
    query_source = self.poller.source_for_id(case.source_id) if case.source_id else self.log_source
    return await _engine_cluster_for_case(
        case, es=self.es, log_source=self.log_source, prefs=self.prefs,
        query_source=query_source, allow_stored_reconstruction=True,
    )
```

Use `self.prefs` and `self.poller.source_for_id`, not `execution_prefs` and `active_source_for_id`. The drain and the job work on the real stack, and those two accessors switch to Demo. The engine helper keeps the case signature and source, and keeps an existing `trigger_reason`. It also adds the entity-window fallback and the stored rebuild: timestamps spread over the trigger window, rules cycled, and `count` restored from `member_event_keys`.

Add a regression test for a push-source case with a one-hour window and 3 rules. It should assert that the drain, the bulk-reinvestigate job and `POST /api/cases/{id}/reinvestigate` give the same `compute_risk` total, and that an aged-out case does not fail in the job when the route succeeds.

### B07. The correlation look-back ignores rule-catalog (Rules editor) correlation windows, so a configured threshold over a longer window can never fire

- Area: engine/poller + engine/ingest correlation window (#1/#4 detection coverage)
- Severity: medium
- Location: `backend/app/engine/poller.py:260`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_correlation_lookback_seconds (poller.py:259-265) and the push equivalent (ingest.py:865-869) take the widest window from default_correlation and correlation_rules only. correlate() resolves catalog rules through prefs.correlation_for_def(rd), which prefers the inline rd.correlation (config.py:4748-4758). The Detection & Rules editor writes that inline correlation on every saved detection rule (webui/src/soc/rules/adapter.ts:64-78, window_seconds from the form). Checked: with default Preferences plus a RuleDefinition(correlation=threshold n=10, window_seconds=3600), Poller._correlation_lookback_seconds returns 180 while correlation_for_def returns window_seconds=3600.

**Failure scenario.**

An operator saves a slow-burn rule: 10 failed logins from one IP within 1 hour. The events arrive one every 5 minutes. Each tick correlates only the last 180 s (about one event), so _window_detail never sees 10, no cluster forms, the cursor advances, and the attack never becomes a case or a candidate. The rule editor shows the rule as active with a 3600 s window.

**Proposed fix.**

Fold every enabled rule_catalog entry's effective correlation window (rd.correlation.window_seconds, and schedule.lookback_seconds where set) into both look-back computations, capped by cold_start_lookback_minutes, through one shared helper that both the poller and IngestService call. Add a test with a 3600 s catalog rule whose events are spread across ticks.

**Skeptic's verdict (first paragraph).**

I confirmed the defect by reading the code and reproducing it at the poller level.

**Skeptic's minimal fix.**

Add one shared helper, for example `Preferences.widest_correlation_window_seconds()` in backend/app/config.py. It returns the largest of:
- default_correlation.window_seconds
- every correlation_rules[*].window_seconds
- prefs.correlation_for_def(rd).window_seconds for every enabled rd in rule_catalog (skip a rule whose mode is NEVER)

Call it from Poller._correlation_lookback_seconds (poller.py:259-261) and from the push look-back in IngestService (ingest.py:865-867) in place of the two inline lists. Keep the existing `max(widest, interval) + 2*interval` formula and the existing cold-start clamp (`window_from = max(window_from, cold_from)`), so the look-back stays bounded by cold_start_lookback_minutes. Leave schedule.lookback_seconds out, because nothing reads it.

Add a test to tests/test_cursor_poller.py: a catalog RuleDefinition with an inline correlation (n=6, 3600 s), events 5 minutes apart and one poll per event, asserting that exactly one case forms. Add the push-path equivalent for IngestService.

### B08. Post-decision threshold automation saves a stale in-memory case after awaiting notification I/O, overwriting a person's concurrent work

- Area: engine/threshold_automation (person vs run)
- Severity: medium
- Location: `backend/app/engine/threshold_automation.py:268`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

ThresholdAutomation.run receives the pipeline's in-memory case after the pipeline's save (pipeline.py:1269), executes the actions in sequence (a notify action awaits notifier.dispatch: state.py:1467, SMTP or webhook I/O), appends to automation_actions (line 367, so 'mutated' is always True), then calls save(case) on that same object (line 268) without re-reading. The pipeline's own _maybe_notify already guards this hazard with fetch=self._cases.get ('never clobbering a concurrent analyst edit (audit #28)', pipeline.py:525-527); automation has no such guard. Repro script <scratchpad>/repro_automation.py: a person sets status INVESTIGATING and assignee 'ann' while the notify send is in flight, and the stored case afterwards reads 'escalated '' 1'.

**Failure scenario.**

An escalated TP case appears in Case Manager the moment the pipeline saves it (case.changed SSE). An analyst acknowledges and takes it while an automation rule's email or Slack notify is still sending. When the send completes, automation saves its copy: the acknowledgement, the assignee and any comment are silently reverted. The audit row says they happened; the case does not show them.

**Proposed fix.**

Re-read the case just before the save and apply only automation's own deltas (the tags added and the automation_actions records) to the fresh copy, as notifications do with fetch. Or record the actions and save first, then perform the network sends.

**Skeptic's verdict (first paragraph).**

I could not refute it. The code path is as described, and I reproduced it against the real Elasticsearch-backed case store.

**Skeptic's minimal fix.**

Make `ThresholdAutomation.run` merge its own changes onto a freshly read case before saving, using the same pattern as `NotificationService.notify`:

1. Add an optional `fetch: Callable[[str], Awaitable[Case | None]] | None = None` keyword to `run`.
2. Before the action loop, record `tags_before = list(case.tags)`, `n_comments = len(case.comments)` and `n_actions = len(case.automation_actions)`.
3. After the status/disposition invariant check and before `save`, when `dirty` and `fetch` is set, call `fresh = await fetch(case.case_id)`. If a `Case` comes back (otherwise keep today's behaviour):
   - add each tag in `case.tags` that is not in `tags_before` and not already in `fresh.tags`, still respecting `CASE_TAG_MAX_COUNT`;
   - set `fresh.comments = [*fresh.comments, *case.comments[n_comments:]]`;
   - set `fresh.automation_actions = [*fresh.automation_actions, *case.automation_actions[n_actions:]]`;
   - `save(fresh)` instead of `case`, and return `fresh`.
4. Wrap the fetch in the existing try/except so a failed read falls back to saving `case`.
5. Pass `fetch=self._cases.get` at pipeline.py:548 and `fetch=self.cases.get` at engine/demo_runtime.py:699.
6. Add a regression test where the notify callable changes the stored case (status, assignee, comment) mid-send and assert those changes survive alongside the `automation_actions` record.

Saving before sending is not enough on its own, because the notify record's outcome comes from the send results.

### B09. Every rebuild of a case drops related_case_ids, cross_source_cluster_id, source_breakdown and automation_actions

- Area: engine/pipeline rebuild carry-over (Round 15 D6.10)
- Severity: medium
- Location: `backend/app/agents/pipeline.py:1759`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_assemble_case, _fail_to_human_case and _register_candidate_locked construct a new Case. _carry_case_work (pipeline.py:1759-1790) carries the people fields only. The cross-source links written by ingest.link_cross_source (ingest.py:666-678) and the append-only automation record written by threshold automation (threshold_automation.py:367, documented as an 'additive audit list') are reset to defaults. Repro script <scratchpad>/repro_rebuild.py prints 'assemble: [] '' {} []' and 'fail: [] '' {} []' for an existing case with related_case_ids=['c2'], a component id, a source breakdown and one automation record. Related: link_cross_source saves full copies of up to 200 pool cases read without their signature lock (ingest.py:580, 678). While another source's poller is mid-investigation of one of them, the investigation's rebuild erases the links just written; in the rarer reverse order, the stale pool copy overwrites the decided case.

**Failure scenario.**

Case A (source 1) and case B (source 2) are linked as related. A gets new events and is re-investigated, or its run fails. A's related list becomes empty while B still points at A: the link is one-sided and the 'source breakdown' chip disappears. Unless the entity recurs inside the 300 s window it is never restored. The case's 'Automation applied' panel (AutomationApplied.tsx) loses every earlier rule action after each re-investigation, so it no longer matches the audit log.

**Proposed fix.**

Carry related_case_ids, cross_source_cluster_id, source_breakdown and automation_actions in _carry_case_work (and in the analyst-policy builder), and pin them in test_round15_wp1_carry.py. In link_cross_source, re-read each case under its signature lock (or patch only the link fields on a fresh read) before saving.

**Skeptic's verdict (first paragraph).**

The report is real, but only part of it is new.

**Skeptic's minimal fix.**

1. In backend/app/agents/pipeline.py `_carry_case_work`, add `case.automation_actions = list(existing.automation_actions or [])` and list automation_actions under "Carried" in its docstring. `ThresholdAutomation.run` then appends this run's records to the carried list, which keeps it append-only.
2. In the analyst-policy builder (pipeline.py around :1462), pass `automation_actions=(list(existing.automation_actions) if existing else [])`.
3. Pin both builders, and the failure builder, in backend/tests/test_round15_wp1_carry.py: an existing case with one automation record keeps it after `_assemble_case`, `_fail_to_human_case` and `_register_candidate_locked`, and a later automation run appends after it.
4. Leave related_case_ids, cross_source_cluster_id, source_breakdown and campaign_id to the "deliberate contract" ROADMAP already records. If that contract is taken up now: carry all three link fields together in `_carry_case_work`, and have `link_cross_source` re-read each case before it saves the link fields (`cases.get` under `signature_lock(case.cluster_signature)`), so a stale pool copy cannot overwrite a decided case.

### B10. A transient case-store read failure at the start of a run mints a second open case for the same signature (#4)

- Area: engine/pipeline failure path
- Severity: medium
- Location: `backend/app/agents/pipeline.py:1283`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

case_id is minted up front (line 876), and find_open_case_for_cluster runs inside the try (line 882). If that read raises (an ES search timeout), the except block (line 1283) builds _fail_to_human_case(case_id=<new id>, existing=None) and saves it. _latest_stored_case returns None for existing=None. handle_clusters' own earlier lookup can succeed while the pipeline's second lookup fails. Repro script <scratchpad>/repro_dup.py makes find_open_by_signature raise once: the signature then has two open cases, ('case-3738…', 'needs_human', '[FAILED] ip:192.0.2.61') and ('case-cf2a…', 'open', 'ip:192.0.2.61 · r').

**Failure scenario.**

Under ES load one search times out during an investigation of an existing candidate. A [FAILED] duplicate is created holding only the new events. From then on find_open_by_signature returns the newest updated case, so later events attach to the duplicate, and the original candidate with its earlier events stays open and uninvestigated forever. Two open cases now exist for one signature.

**Proposed fix.**

If the identity lookup fails, do not mint a case: re-raise, so the poller and receiver retry boundary replays the batch (the cursor is not advanced). Or retry the lookup and fail only when it is proven that no open case exists. Fall back to fail-to-human only after existing is known.

**Skeptic's verdict (first paragraph).**

The defect is real. I reproduced it on the current tree. git log shows 3cd362c, not the 3cfd5c0 the task names, but the code is the same.

**Skeptic's minimal fix.**

In `_investigate_cluster_run` (`backend/app/agents/pipeline.py` ~876-884), run the identity lookup before the `try`, the same way `_register_candidate_locked` does, so a lookup failure propagates and no case is minted:

```python
existing: Case | None = await find_open_case_for_cluster(self._cases, cluster)
case_id = existing.case_id if existing else new_id("case-")
procedure_provenance: dict[str, Any] = {}
try:
    policy_case = await self._close_by_analyst_policy(...)
    ...
```

Remove the in-try `existing = await find_open_case_for_cluster(...)` / `if existing: case_id = existing.case_id` lines.

A failed lookup then reaches the existing retry boundaries:
- The poller tick fails and its cursor is not advanced.
- IngestService raises `IngestBatchError` and the batch is retried, as `tests/test_ingest_acknowledgement.py` already expects for the ingest-level lookup.
- API and job callers get an error and the person retries.

Fail-to-human is used only once the case identity is known.

Add a regression test: `register_candidate`, then `investigate_cluster` with `find_open_by_signature` raising once. Assert that it raises and that exactly one open case exists for the signature.

### B11. The deferred-candidate drain re-scans every OPEN case each tick, and on Elasticsearch it can never reach candidates past the first 10,000

- Area: engine/poller_manager._drain_deferred (#4 drain promise, scale)
- Severity: medium
- Location: `backend/app/engine/poller_manager.py:483`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_drain_deferred pages CaseStore.list(status=OPEN, sort created_at asc) from offset 0 until drained == limit or offset >= total (poller_manager.py:480-512). Below-floor candidates stay OPEN until a person acts, so the OPEN population grows without bound under comprehensive ingestion. With no deferred cases (the normal state) every tick reads all of them: 10,000 cases is 200 queries every poll interval. CaseStore.list does not set track_total_hits (cases.py:190-199), so on real ES total is capped at 10,000 and the loop stops there; a cap-deferred candidate created after the 10,000th oldest OPEN case is never seen by the drain. Drained cases also leave the OPEN filter mid-scan while offset += len(page) (line 510), so rows that shift up are skipped for that tick.

**Failure scenario.**

A tenant with 12,000 open below-floor candidates has a burst that defers 30 alerts past the per-tick cap. None of them receives another event. They keep 'deferred: ... drains to investigation on a later tick' forever, because the drain only ever pages the 10,000 oldest OPEN cases, while each 30 s tick issues about 200 deep-offset searches.

**Proposed fix.**

Query the queue directly: filter on awaiting_reason prefix 'deferred:' (a keyword prefix term, or a dedicated boolean field set by _candidate_reason) with verdict missing, sorted by updated_at, limited to limit. Or use search_after/PIT and re-query from offset 0 after each drained page. Set track_total_hits where totals bound a loop.

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. The defect is real.

**Skeptic's minimal fix.**

Make the drain query the deferred queue directly instead of scanning every OPEN case.
1. Add `CaseRepository.list_deferred_candidates(*, older_than: str, limit: int) -> list[Case]`. The base default keeps today's paged scan for third-party stores.
2. Elasticsearch `CaseStore` implementation: one search with `size=limit` and `sort created_at asc`. The query is `bool.filter=[{term:{status:'open'}}, {prefix:{'awaiting_reason.keyword':'deferred:'}}, {range:{updated_at:{lt:older_than}}}]` plus `must_not=[{exists:{field:'verdict'}}]`. Add `awaiting_reason` as a `keyword` (or text with a `.keyword` subfield) to the cases mapping through the existing missing-properties extension so new indices do not depend on dynamic mapping.
3. SQL implementation: `WHERE status='open' AND verdict IS NULL AND <awaiting_reason> LIKE 'deferred:%' AND updated_at < :older_than ORDER BY created_at LIMIT :limit`, using the JSON document field the repository already stores.
4. In `_drain_deferred`, call the new method once per tick and investigate each returned case: keep the `cluster_for_case` None skip, and stop at `limit`. Remove the offset loop. This also removes the mid-scan skip.
5. Add a regression test that runs over a fake configured like real Elasticsearch (track_total_hits 10,000 when absent, from+size over 10,000 rejected). Seed more than 10,000 OPEN below-floor candidates plus one newer deferred case, and assert it drains in a bounded number of searches.

Interim fix if a new repository method is not wanted: pass `track_total_hits` and page with search_after/PIT so the 10,000 cap and the max_result_window rejection go away. This alone keeps the per-tick full scan.

### B12. A failed run resets the case's token_cost to $0 and drops the run's partial spend

- Area: engine/pipeline cost accounting (#6 presentation)
- Severity: low
- Location: `backend/app/agents/pipeline.py:1876`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_fail_to_human_case builds Case(...) without token_cost (the default is 0.0), and _carry_case_work does not carry it. The except path does not pass the cost accumulated before the exception. Checked: existing.token_cost=0.4321 becomes 0.0 on the fail-to-human rebuild. The ledger still holds the rows, so Case.token_cost no longer reconciles with the usage ledger until a later successful run adopts the ledger total.

**Failure scenario.**

A case that cost $0.43 across two investigations fails on its third (a formatter exception). The case and Cost views show $0.00 for it and the per-case cost totals under-count, while the ledger shows $0.43 plus the partial spend of the failed run.

**Proposed fix.**

In _fail_to_human_case, set token_cost=round((existing.token_cost if existing else 0.0) + partial_cost, 6), passing the run's accumulated cost from the except path, or reconcile with gateway.recorded_case_pipeline_cost as the success path does.

**Skeptic's verdict (first paragraph).**

The defect is real. I confirmed it in the code and reproduced it.

**Skeptic's minimal fix.**

The fix has two parts.

1. In `_fail_to_human_case` (backend/app/agents/pipeline.py:1876), keep the stored total by adding `token_cost=(existing.token_cost if existing else 0.0),` to the `Case(...)` call.

2. In the pipeline's `except Exception` path, after `case = _fail_to_human_case(...)` and before `await self._cases.save(case)`, add the failed run's spend by reconciling with the ledger, as the success path does:

```python
try:
    recorded = await self._gateway.recorded_case_pipeline_cost(case_id)
except Exception:  # noqa: BLE001 - accounting is fail-soft
    recorded = None
if recorded is not None and recorded > case.token_cost:
    case.token_cost = recorded
```

Reading from the ledger avoids double-counting. If `cost_accum` were summed in the except path instead, it would double-count whenever the exception is raised after `cost += flow_cost`. If you also want a fallback for when the ledger read fails, initialise `cost = 0.0` and `cost_accum = []` before the outer try. Then use `max(existing_cost + sum(cost_accum), recorded or 0)`, never `cost + sum(cost_accum)`.

Add a regression test: a stored case with `token_cost=0.4321`, rebuilt by `_fail_to_human_case`, keeps 0.4321, and a run that fails mid-investigation ends with `token_cost` equal to the ledger total.

### B13. The risk score cannot be cross-verified: the factor inputs are not stored, and the Console pairs the post-attach member count with a volume factor computed from a different count

- Area: engine/risk + case model (data visibility; the operator's '81, show me the math' ask)
- Severity: medium
- Location: `backend/app/engine/risk.py:111`
- Owning package: WP10
- Merged into: none
- Skeptic verdict: real

**Evidence.**

compute_risk persists only the five rounded factor scores and the total (RiskBreakdown, models.py:282-288). Nothing records the inputs: the event count, window seconds, rate, distinct rules, reputation input, the asset/CIDR match and the weights used. attach_cluster (ingest.py:233-276) adds members to a decided case but never updates risk, which is correct for #3, so the case's member count drifts from the count the score used. SignalProfile.caseRiskFactors (webui SignalProfile.tsx:271-278) uses member_event_keys.length as the volume context, so a case decided on 3 events (Volume = 100*ln(4)/ln(51) = 35.26) that later attached 47 more reads 'The case records 50 correlated events; its stored Volume factor is 35/100', and 50 events would give 100. routes_triage._risk_calculation re-blends the stored factors with the CURRENT weights (state.prefs, not the stack's execution_prefs), so after a weight change, or in Demo Mode, matches_displayed_score is false with no record of the original weights.

**Failure scenario.**

An analyst hovers Risk 81 to check the math. The factor rows cannot be recomputed: the count shown is not the count used, velocity has no span, reputation and asset have no inputs, and the weights shown may not be the ones used. The number cannot be verified, and after any attach it visibly contradicts its own explanation.

**Proposed fix.**

Add an additive risk_inputs block to RiskBreakdown, written by compute_risk: count, window_seconds, rate_per_min, distinct_rules (the list), reputation_input with its source, the asset match (cidr or exact) and its criticality, the weights and the reference constants (_VOLUME_REF, _VELOCITY_REF, _DIVERSITY_REF). Show those in the hover, and label the member count as 'events since the score was computed' when it differs. No schema migration is needed (JSON on every backend); decide() is untouched.

**Skeptic's verdict (first paragraph).**

Mostly confirmed, but narrower than reported. One part is a real display defect, one is a feature gap, and one is already handled.

**Skeptic's minimal fix.**

Store the inputs once, when the score is computed, and stop treating the case's current member count as the scoring input.

1. backend/app/models.py: add an additive optional field to `RiskBreakdown`, `inputs: RiskInputs | None = None`. `RiskInputs` holds:
   - count, window_seconds, rate_per_min, and whether velocity applied (count >= 3)
   - the distinct rule values
   - the reputation input before clamping, and its source ("enrichment" or "none")
   - the asset match kind ("cidr", "exact" or "none"), the matched key and its criticality
   - a weights snapshot, and the references (50, 10.0, 5)

2. backend/app/engine/risk.py `compute_risk`: fill `inputs`. Do not change any factor or the total. Leave `compute_routing_risk` and `decide()` as they are. No migration is needed: the field is JSON on SQL, and the ES `risk_breakdown` mapping is a dynamic object (es/indices.py:81).

3. backend/app/api/routes_triage.py:704: pass `state.execution_prefs` instead of `state.prefs`. In `_risk_calculation`, when `rb.inputs` carries a weights snapshot, use it and set `weight_basis="recorded"`. Otherwise keep the current-weights path and its mismatch note.

4. webui SignalProfile.tsx `caseRiskFactors` and `riskFactorCaseReason`:
   - Read count, span, rules, reputation and asset from `risk_breakdown.inputs` when present.
   - Without them, never pair `member_event_keys.length` with the Volume factor. Use the "event count not retained" wording, and show the member count only as a separate fact: "the case now holds N events; the score was computed from the events in its scoring run".
   - Mirror the new fields in CaseDetail.api.ts and lib/types.ts.

5. Add an offline test: score a 3-event cluster, run `attach_cluster` with 47 more events, and assert that the stored inputs still say 3 and that the tooltip does not claim 50.

### B14. A bulk reinvestigate job reports an item as succeeded when the investigation failed

- Area: engine/jobs._case_reinvestigate
- Severity: low
- Location: `backend/app/engine/jobs.py:737`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

investigate_cluster never raises on an investigation failure: it returns a fail-to-human case titled '[FAILED] …' (pipeline.py:1283-1329). _item_loop marks the item succeeded whenever run() returns (jobs.py:664-667), so the job result counts {succeeded: N} even when every case came back [FAILED].

**Failure scenario.**

The provider is down and an analyst bulk-reinvestigates 40 cases. The Jobs page and the terminal toast say 40 succeeded, while all 40 cases show '[FAILED] Automated investigation failed'.

**Proposed fix.**

After investigate_cluster, treat a returned case with a non-empty error or the [FAILED] title from this run as a failed item (raise inside run), or add a distinct 'completed_with_failure' item state.

**Skeptic's verdict (first paragraph).**

I reproduced the core claim, but the reported failure scenario is wrong.

**Skeptic's minimal fix.**

In backend/app/engine/jobs.py `_case_reinvestigate.run`, keep the returned case and fail the item when this run ended in a failure:

```python
updated = await self.state.real_pipeline.investigate_cluster(
    cluster, case.source_surface, prefs, force=True,
    query_source=query_source, investigation_priority="background",
)
if updated is not None and (updated.error or (updated.title or "").startswith("[FAILED]")):
    raise RuntimeError(
        "The automated investigation failed; the case was routed to a person for review."
    )
```

`_assemble_case` writes `error` only for the current run and `None` on ordinary runs, so a stale error never carries over. Use a fixed message rather than `updated.error` so the job failure detail never repeats exception text. `_item_loop` already turns the `RuntimeError` into a failed item. That item is not re-run, which matches the fail-closed rule for unsafe items. The case save stays as it is. The job then ends FAILED or PARTIAL, and the Console shows "completed with failures" or "failed" with the right counts. Add a regression test that patches a pipeline step (for example `compute_risk`) to raise and asserts `counts.failed == total`.

### B15. A settings:manage holder can mint a stored Super admin through SSO, bypassing the Round 15 Super-admin-only boundary

- Area: auth-security / SSO + Super admin guards
- Severity: high
- Location: `backend/app/api/routes.py:5553`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`_require_super_admin_for` (routes.py:5899) stops `POST /api/users {role: super_admin}` for anyone whose stored role is not super_admin. But the SSO provider config (`Preferences.sso`, config.py:3669-3690) is written by plain `PUT /api/settings` (settings:manage only, no fresh sign-in, no check on `default_role`/`group_role_map` values), the client secret by `POST /api/auth/sso/providers/{id}/secret` behind `require_admin` = users:manage (routes.py:5784, deps.py:1062). `sso_callback` takes `role = prov.role_for(identity)` (routes.py:5553, oidc.py:302-309, falls back to `default_role` unvalidated) and `_provision_sso_user` creates or re-roles the account with it (routes.py:5673, create path) with no Super admin check. The SOC manager holds settings:manage, roles:manage and users:manage by default (rbac/policy.py:441-457); with RBAC off (the default, config.py:3411) every signed-in account does. Reproduced with probe <scratchpad>/probes/test_probe_auth.py::test_soc_manager_mints_super_admin_via_sso (RBAC on): as soc_manager, `POST /api/users {role: super_admin}` -> 403 super_admin_only; `PUT /api/settings {sso:{enabled:true, providers:[{id:'evil', type:'generic', discovery_url:..., auto_create_users:true, default_role:'super_admin'}]}}` -> 200; secret -> 200; SSO callback -> 302 '/'; `users.get('boss@evil.test')` -> role SUPER_ADMIN; that session's `PUT /api/rbac {enabled:false}` -> 200 (`caller_role: super_admin`).

**Failure scenario.**

A SOC manager (or, while RBAC is off, any analyst) points a generic OIDC provider at an IdP they control with default_role or a group map of super_admin, signs in through it and holds a stored Super admin. That account can turn role-based access off (PUT /api/rbac), take over or delete the real Super admins, and pass `require_system_update_operator` (deps.py:1151, stored role) to apply system updates. Those are exactly the boundaries Round 15 reserved for stored Super admins.

**Proposed fix.**

Treat a change to `sso` (providers, group_role_map, default_role, auto_create_users, discovery_url) like the RBAC matrix: in `_guard_rbac_settings_change`, or a sibling guard in put_settings, require a stored Super admin plus `require_strict_fresh_sign_in` whenever any role value in sso maps to or changes to super_admin, or whenever the sso block changes at all. Validate default_role and group_role_map values against the built-in roles and custom roles. In `_provision_sso_user`, refuse to create an account as super_admin, or promote one to it, through the group map unless a Super admin configured that exact mapping. Restrict `POST /api/auth/sso/providers/{id}/secret` to a stored Super admin. Add a regression test equivalent to the probe.

**Skeptic's verdict (first paragraph).**

I could not refute it. I re-read the code path and re-ran the probe at 3cd362c. The probe passed and printed: direct `POST /api/users {role: super_admin}` as soc_manager -> 403 super_admin_only; `PUT /api/settings` with an `sso` provider whose `default_role` is super_admin -> 200; `POST /api/auth/sso/providers/evil/secret` -> 200; SSO callback -> 302 /; `users.get('boss@evil.test')` -> UserRole.SUPER_ADMIN; that session's `PUT /api/rbac {enabled:false}` -> 200 with `caller_role: super_admin`.

**Skeptic's minimal fix.**

1. In `put_settings` (routes.py), add a sibling to `_guard_rbac_settings_change` that compares `current.sso` with `validated.sso`, using the same `_RbacEditAuthorityNeeded`-style retry loop (`authorized` flag, async check, then re-run). Call a provider "super-admin-capable" when its `default_role == 'super_admin'` or any `group_role_map` value is `super_admin`. If the save adds, removes or changes any provider that is super-admin-capable before or after the save, require `await _require_super_admin_for(request, state)`. That covers its identity fields (`discovery_url`, `type`, `tenant`, `client_id`, `allowed_domains`, `allowed_tenants`, `group_claim`, `auto_create_users`, `enabled`), its roles, and the top-level `sso.enabled`. Otherwise raise 403 `super_admin_only` with nothing saved. The check runs before the audited write, so a refusal changes nothing.
2. Validate role values in `SSOProvider` (or in the guard). `default_role` and every `group_role_map` value must be a `UserRole` value or a known custom role id; anything else answers 422.
3. In `set_sso_provider_secret` (routes.py:5784), also call `_require_super_admin_for` when the target provider is super-admin-capable.
4. Optional defence in depth: in `_provision_sso_user`, refuse to change the role of an existing account whose stored role is `super_admin` (no demotion by group map), and log `auth.login_failed` if a role outside the valid set comes through.
5. Add a regression test equal to the probe. As soc_manager with RBAC on, the `PUT /api/settings` that sets `default_role` or a group map to `super_admin` must answer 403 `super_admin_only` and leave `prefs.sso` unchanged. Add a second case: soc_manager changes `discovery_url` on a provider a Super admin mapped to `super_admin` and gets 403. Add a third case: a Super admin with a fresh sign-in gets 200.

### B16. SSO links any account provisioned by another provider when the email matches (cross-provider account takeover, Super admins included)

- Area: auth-security / SSO account linking
- Severity: high
- Location: `backend/app/api/routes.py:5663`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`_provision_sso_user` step 2 refuses a verified-email match only when `is_local_account = bool(candidate.password_hash) and not candidate.oauth_provider` (routes.py:5663). An account created by provider A has `oauth_provider='A'`, so a login through provider B asserting the same verified email takes `existing = candidate` and rewrites `oauth_provider`/`oauth_sub` to B's values (routes.py:5675-5681), even when B has `auto_create_users=false`. Probe test_cross_provider_sso_takeover: provider 'corp' provisions chief@corp.test as super_admin (sub victim-sub); provider 'other' (auto_create off) asserts {sub: attacker-sub, email: chief@corp.test, email_verified: true} -> 302 '/', `/api/auth/me` -> {username: chief@corp.test, role: super_admin}, and the stored link becomes oauth_provider='other', oauth_sub='attacker-sub'.

**Failure scenario.**

A deployment configures Google Workspace and a second IdP such as a partner Keycloak or a generic OIDC provider where users can register addresses that the IdP marks verified. A user of the second IdP who registers a Google-provisioned admin's address signs in as that admin and re-binds the account to their own subject, so the docstring's own threat ('an attacker whose IdP account carries a victim's address log in AS the victim') applies across providers. Combined with the previous finding, a SOC manager can add such a provider and take over every SSO-provisioned Super admin directly.

**Proposed fix.**

Link by verified email only when the candidate has no provider link or is already linked to this same provider (`candidate.oauth_provider in ('', provider_id)`). Otherwise refuse with an `sso link refused` denied row, as the local-account case does. Never overwrite an existing `(oauth_provider, oauth_sub)` from a different provider; cross-provider linking should be an explicit admin action. Extend test_oidc.py with the two-provider case.

**Skeptic's verdict (first paragraph).**

The defect is real. I reproduced it.

**Skeptic's minimal fix.**

In `_provision_sso_user` step 2 (backend/app/api/routes.py:5661-5666), link by verified email only to an account already bound to this same provider. Refuse every other match the same way the local-account case is refused:

```python
if candidate is not None:
    if candidate.oauth_provider != provider_id:
        kind = "a local account" if not candidate.oauth_provider else f"an account linked to {candidate.oauth_provider}"
        return None, f"sso link refused: {provider_id} email matches {kind}"
    existing = candidate
```

This never overwrites an existing `(oauth_provider, oauth_sub)` that a different provider set, and the caller still writes the `auth.login_failed` denied row. Linking across providers then becomes an explicit administrator action.

Add a two-provider regression test to backend/tests/test_oidc.py:
- Provider A provisions a Super admin.
- Provider B, with auto-create off, asserts the same verified email.
- Expect `sso_error=user_not_provisioned` and the A link left unchanged.

Hardening that goes with the fix: in oidc.py `identity_from`, read `hd` only when `self.type == "google"`, and otherwise derive `domain` from the email. Without that, an IdP that is not Google can pass any `allowed_domains` list.

### B17. An existing MFA factor can be replaced from a bare session without proving the old factor or re-authenticating

- Area: auth-security / MFA enrolment
- Severity: medium
- Location: `backend/app/api/routes.py:5010`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`/auth/mfa/disable` requires a current TOTP or recovery code 'so a hijacked session alone cannot turn MFA off' (routes.py:5354-5377). `/auth/mfa/setup` (routes.py:5010) and `/auth/mfa/confirm` (routes.py:5040) never check `user.mfa_enabled`, ask for no current factor and no `require_fresh_auth`, and confirm overwrites `mfa_secret` and `mfa_recovery_hashes`. Probe test_mfa_factor_replaced_without_old_factor: after enrolling secret s1, `POST /api/auth/mfa/setup` -> 200 with a new secret s2, `POST /api/auth/mfa/confirm` (code from s2) -> 200, and a code from the original s1 is then refused (`/auth/mfa/disable` with an s1 code -> 400 invalid code).

**Failure scenario.**

An attacker holding a stolen session cookie or bearer token (no password, no second factor) enrols their own authenticator over the victim's. The victim's authenticator and recovery codes stop working and the victim is locked out. The attacker's factor now satisfies every later MFA challenge, including `/auth/mfa/disable`. This is the same result the disable route was written to prevent.

**Proposed fix.**

When `mfa_enabled` is already true, make `/auth/mfa/setup` and `/auth/mfa/confirm` require a valid current TOTP or recovery code (or answer 409 and point to disable first), and add `require_fresh_auth()` to both routes. Clear `_MFA_PENDING_ENROLL` when it is unused. Add a test that setup while enrolled is refused without the current factor.

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. The code path and the probe both confirm it.

**Skeptic's minimal fix.**

In backend/app/api/routes.py, make the session-authed enrolment routes refuse an account that already has a factor, matching the login-phase guard in `_enroll_pending_user`:

```python
# mfa_setup, after principal = _require_session(state, request):
user = await state.users.get(principal.username)
if user is not None and user.mfa_enabled:
    raise HTTPException(status_code=409, detail="MFA is already enabled; turn it off with a current code before enrolling a new authenticator")

# mfa_confirm, after user = await state.users.get(...) and the None check, before the write:
if user.mfa_enabled:
    _MFA_PENDING_ENROLL.pop(principal.username.strip().lower(), None)
    raise HTTPException(status_code=409, detail="MFA is already enabled; turn it off with a current code before enrolling a new authenticator")
```

The check in confirm also closes the case where setup ran before MFA was turned on (for example from the login-phase path) and confirm runs afterwards. Users who want a new authenticator go through `/auth/mfa/disable`, which already needs a current code, and then enrol again. The Console's MfaSetupCard already works this way.

If the project prefers to allow replacement in place, setup and confirm should instead require a current TOTP or recovery code checked exactly as in `mfa_disable` (with `last_step` replay protection and the `auth.mfa_failed` audit on failure), and should add `Depends(require_fresh_auth())`.

Add a regression test to backend/tests/test_mfa_login_flow.py: after `_enroll_mfa`, `/auth/mfa/setup` and `/auth/mfa/confirm` with the bare session return 409, and the original secret and recovery codes still work.

### B18. Password hashing runs on the event loop: unauthenticated logins and wrong MFA codes stall every request

- Area: auth-security / availability (login, MFA)
- Severity: medium
- Location: `backend/app/api/routes.py:4033`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`auth_login` calls the synchronous PBKDF2-SHA256 (310,000 iterations, passwords.py:25) through `auth.check_password` inside `async def` (routes.py:4033). `mfa_verify` checks a failed TOTP against every recovery hash with `verify_recovery_code` (PBKDF2, mfa.py:209), up to 10 per request (routes.py:5127). `/auth/mfa/setup` and `/auth/mfa/enroll-setup` hash 10 codes each. None of this is offloaded (`asyncio.to_thread` appears in auth/ only for OIDC HTTP), and the rate limiter is off by default (config.py:250). Measured live on a probe backend (127.0.0.1:8912, stopped since): one verify takes 80 ms; 60 concurrent bad logins (unknown users, no session) held /api/health/live to 4,504 ms worst latency against a 4 ms baseline (scratchpad stall2.py); 10 wrong MFA codes on one pending token took 8.8 s and held health to 4,647 ms (scratchpad mfa_stall.py); `/auth/mfa/setup` took 0.83 s.

**Failure scenario.**

An unauthenticated client sends about 12 bad logins a second, or someone who knows one password sends a stream of wrong MFA codes. The single event loop is then busy with PBKDF2: SSE heartbeats, chat streams, polling and the readiness probe stall for seconds, and an orchestrator health check can restart the backend.

**Proposed fix.**

Run `verify_password` and `hash_password` through `await asyncio.to_thread(...)` (or a small bounded executor) in login, change-password, reauth, MFA verify, disable, setup and enroll-setup, the user create and reset paths, and setup/account. Cap concurrent hashing with a semaphore so a flood queues and is refused rather than using every CPU. Check the code shape first so a 6-digit TOTP-shaped code never runs the recovery-code PBKDF2 loop.

**Skeptic's verdict (first paragraph).**

I could not refute it. The code path is as reported, and I reproduced the stall in process.

**Skeptic's minimal fix.**

1. In backend/app/auth/passwords.py, add async wrappers and route every PBKDF2 call through them:

```python
_HASH_SEM = asyncio.Semaphore(max(2, (os.cpu_count() or 2) // 2))

async def averify_password(password, stored):
    async with _HASH_SEM:
        return await asyncio.to_thread(verify_password, password, stored)

async def ahash_password(password):
    async with _HASH_SEM:
        return await asyncio.to_thread(hash_password, password)
```

   Also add `async def acheck_password` in AuthService. It should do the same `_lookup` and `_DUMMY_HASH` equalisation, then `await averify_password(...)`.

2. In routes.py, use those wrappers:
   - routes.py:4033: `checked = await auth.acheck_password(...)`. Do the same for the change-password and reauth checks.
   - The `hash_password` calls at routes.py:4317, 5728, 6053, 6120 and routes_setup.py:192: `await ahash_password(...)`.

3. In mfa.py, give the recovery codes the same treatment:
   - Add `async def averify_recovery_code` and `async def ahash_recovery_codes(codes)`; the second hashes all codes in one `to_thread` call.
   - In `mfa_verify` (routes.py:5125) and the MFA disable check (routes.py:5377), loop with `await averify_recovery_code`.
   - At routes.py:5026 and :5254, use `ahash_recovery_codes`.

4. Before the recovery loop, skip it when the normalised code cannot be a recovery code. A recovery code is 8 hex characters, so a 6-digit TOTP-shaped input never runs the 10-hash PBKDF2 scan:

```python
if len(mfa_mod._norm_recovery(body.code)) == 8:
    ...
```

   `_norm_recovery` uppercases and strips dashes and spaces.

5. Optional: when the semaphore is saturated beyond a small queue depth, answer 429 rather than queueing without limit.

### B19. MFA verification has no attempt bound, and a pending token stays reusable for its whole 5 minutes

- Area: auth-security / MFA challenge
- Severity: medium
- Location: `backend/app/api/routes.py:5092`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`mfa_verify` (routes.py:5092-5140) holds no failure counter per user or per pending token, and `pending_subject` (auth/service.py:554) has no single-use or attempt state. The pending token lives `_MFA_PENDING_SECONDS = 5*60` (service.py:53), and a new one costs only another password login. All 10 wrong codes on one pending token in the live run answered 401, with no lockout or 429. The global token-bucket limiter is off by default (config.py:250) and keys on IP only. NIST SP 800-63B §5.2.2 asks OTP verifiers to limit consecutive failed attempts on one account (100 at most).

**Failure scenario.**

An attacker with a phished or reused password guesses TOTP codes indefinitely. With `window=1` (3 valid codes per guess), about 43,000 guesses a day at the PBKDF2-limited rate gives roughly a 12% chance a day of passing the second factor, and more with several backend processes or once the hashing is moved off the loop.

**Proposed fix.**

Keep a per-account failed-second-factor counter in the user record or KV, with lockout or exponential back-off after N failures (for example 10), reset on success. Bind the pending token to a server-side nonce that is consumed on success and invalidated after N failures. Record the lockout as an identity audit row.

**Skeptic's verdict (first paragraph).**

I could not refute this. It reproduces as reported, and none of the listed records mention it.

**Skeptic's minimal fix.**

In `mfa_verify` (backend/app/api/routes.py), add a per-account consecutive-failure bound, checked before any code is verified:

1. Keep `mfa_failed_count` and `mfa_locked_until` on the user record through `state.users.update` (KV-backed user store, no new index). Read them from `user` at the top of `mfa_verify`.
2. If `mfa_locked_until` is in the future, answer 429 "too many attempts, try again later" without running the TOTP or recovery checks. Write an `auth.mfa_failed` row with outcome `denied`.
3. On each failure, increment `mfa_failed_count`. When it reaches a threshold such as 10, set `mfa_locked_until` to now plus an exponential back-off (for example 5 minutes, doubling up to 1 hour) and write an `auth.mfa_locked` identity audit row.
4. On a successful TOTP or recovery code, reset both fields to 0 and null in the same `users.update`.
5. Make the pending token bounded too: add a random `jti` in `begin_mfa()`, keep a bounded process-local map of `jti` to failure count, and reject the token (401 "invalid or expired pending session") after 5 failures or once it has been used successfully. That makes it single-use after a session is minted.
6. Apply the same per-account counter to the pending-token-gated mandated-enrollment confirm path, which writes the other `auth.mfa_failed` rows near routes.py:5288 and 5380.

Also move the recovery-hash PBKDF2 loop off the event loop with `await asyncio.to_thread(...)`. Add a regression test: N wrong codes, then the correct code answers 429 until the lock window passes, and a success resets the counter.

### B20. must_change_password is not enforced by the server, and the seeded Admin/Admin@123 is not even flagged (contradicts USAGE.md)

- Area: auth-security / password lifecycle
- Severity: medium
- Location: `backend/app/state.py:2842`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

docs/USAGE.md:2000-2004 says the first-boot seed `Admin`/`Admin@123` is created 'with must_change_password=true' and that 'the login flow ... forces a change-password step ... before it issues a real session'. In fact `seed_users` creates it with `must_change_password=False` (state.py:2842, since ba17965), and `auth_login` mints a full session regardless of the flag (routes.py:4076-4110). `require_auth` never consults the flag; only `require_system_update_operator` does (deps.py:1159), and the Console gates it client-side (App.tsx:108). Live: login as Admin/Admin@123 -> `must_change_password: False`. A user created by an admin (`must_change_password: true`) got a token on login, and `GET /api/cases` with it -> 200.

**Failure scenario.**

A deployment left on the seeded known credential is never pushed to rotate it, although the documentation promises it is. A temporary password an administrator set and sent out (users:manage reset sets must_change_password=True, routes.py:6121) stays fully usable for API and bearer clients, so whoever reads that message can use the account indefinitely without the forced rotation.

**Proposed fix.**

Seed the demo admin with `must_change_password=True`, or correct USAGE.md if that is intended. Enforce the flag server-side: while it is set, `require_auth` should answer `403 password_change_required` for every route except /auth/me, /auth/change-password, /auth/logout and /account/me.

**Skeptic's verdict (first paragraph).**

The report is partly right. Its main claim, that the server does not enforce the forced password change, is real and I reproduced it. The seeded-admin part is not a code defect: it is a documentation error.

**Skeptic's minimal fix.**

Server side, in backend/app/api/deps.py require_auth: after `await _session_check(...)`, add `if user.must_change_password and path not in _PASSWORD_CHANGE_ALLOWED: raise HTTPException(403, detail={"code": "password_change_required", "message": "Change your temporary password to continue."})`. Use a small frozenset for the allowlist: {"/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/refresh", "/api/account/me"} plus any GET the Login screen needs while in change mode (branding is already public). The flag is read live from the synced record, so it clears on the next request after change-password and refresh_users. Update the tests that rely on a flagged user reaching /api/cases: tests/test_rbac_users.py test_rbac_denies_low_role_and_allows_admin and test_rbac_on_enforces_user_management_and_close. Either change the password first or assert the new 403. Add a regression test: a flagged user's bearer token gets 403 on /api/cases and on POST /api/users, then 200 after POST /api/auth/change-password. Leave the seeded demo Admin as it is (state.py:2842 is intentional per config.py:232-236). Instead, correct docs/USAGE.md:2000-2004 and 2373-2374 and DEMO.md:129 to say the seeded demo Admin is deliberately not forced to change its password (rotate it yourself, or set TLSOC_AUTH_SEED_ADMIN=false). Also say the forced change applies to accounts an administrator creates or resets.

### B21. Changing or resetting a password leaves every existing session signed in

- Area: auth-security / sessions
- Severity: low
- Location: `backend/app/api/routes.py:4279`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Neither `auth_change_password` (routes.py:4279-4333) nor the users:manage reset in `update_user` (routes.py:6114-6121) calls `sessions.revoke_all`/`revoke_others` or bumps the token version. Live: temp1's session cookie answered `/api/account/me` 200 before an admin reset, 200 after it, and was then used to change the password (200), and still answered `/api/cases` 200. Round 14 research (small-asks.md:122) assumes 'password change' ends in `tv_mismatch`.

**Failure scenario.**

An administrator responding to a compromised account (the bundled compromised-account runbook says 'Revoke sessions and reset the password') resets the password, but the attacker's live session (up to 12 h, or 144 h for bearer clients) keeps working until someone also finds Sessions and runs 'Revoke all'. The same holds for a user who changes their own password after noticing a takeover.

**Proposed fix.**

After a successful self-change, revoke the caller's other sessions (keep the current one). After an admin reset, call `revoke_all` (tv bump) for the target. Mention it in the change-password and reset responses and in docs/administration/authentication.md.

**Skeptic's verdict (first paragraph).**

I could not refute it. The code path is as reported, and I reproduced it over the real router.

**Skeptic's minimal fix.**

In backend/app/api/routes.py:

1. `auth_change_password`: after `audited_write(...)` and `state.refresh_users()`, sign out the caller's other sessions and keep the current one:
```python
keep = principal.sid or ""
revoked = await state.sessions.revoke_others(principal.username, keep, by=principal.username, reason="password_changed") if keep else await state.sessions.revoke_all(principal.username, by=principal.username, reason="password_changed")
await _stop_chat_turns(state, principal.username, except_sid=keep or None)
await _record_identity_event(state, request, action="session.revoked", actor=principal.username, surface="session", target=_user_target(principal.username), summary=_session_summary("session_revoke_others", keep, f"password changed: revoked {revoked} other session(s)"), tool_input={"scope": "others", "count": int(revoked or 0)})
return {"ok": True, "sessions_revoked": int(revoked or 0)}
```
   - Use `revoke_others`, not `revoke_all(except_sid=...)`. `revoke_all` bumps the token version, which would also reject the caller's own token.
   - Sessions are registered at login and, lazily, on first use, so any session the attacker has used gets revoked.

2. `update_user`: when `"password_hash" in patch`, do a global sign-out of the target after the audited write, the same way `admin_revoke_all` does (routes.py:4620-4643):
```python
if "password_hash" in patch:
    by = current_username(request)
    n = await state.sessions.revoke_all(username, by=by, reason="admin_password_reset")
    await state.refresh_sessions()
    await _stop_chat_turns(state, username)
    await _record_identity_event(state, request, action="session.revoked", actor=by, surface="session", target=_user_target(username), summary=_session_summary("session_admin_revoke_all", "", f"password reset: revoked {n} session(s) for {username}"), tool_input={"scope": "all", "count": int(n or 0)})
```
   - This bumps the token version, so even unregistered tokens get `tv_mismatch`.
   - If the admin resets their own password, they are signed out as well; that is acceptable.

3. Add two regression tests in tests/test_sessions.py:
   - An old token answers 401 `tv_mismatch` after an admin reset.
   - Another session answers 401 `revoked` after a self-change, and the caller's session stays 200.

4. Add one line to docs/administration/authentication.md and users-rbac.md saying that changing a password signs out your other sessions, and an admin reset signs out all of the account's sessions.

### B22. The session registry records a client-chosen IP (first X-Forwarded-For entry) in the session list and new-device notices

- Area: auth-security / session metadata integrity
- Severity: low
- Location: `backend/app/state.py:4332`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`session_metadata` (deps.py:335) uses `client_ip_from`, which returns the FIRST X-Forwarded-For entry unconditionally (state.py:4326-4334). The bundled nginx appends to the client's header (`proxy_add_x_forwarded_for`, webui/nginx.conf), so the first entry is attacker-supplied. The audit context deliberately uses the rightmost untrusted hop instead (audit/context.py:17-26 notes `client_ip_from` 'stays as it is for session metadata'). Live: `POST /api/auth/login` with `X-Forwarded-For: 203.0.113.77` -> `GET /api/sessions` shows `ip: 203.0.113.77`.

**Failure scenario.**

An intruder who signs in with stolen credentials sets X-Forwarded-For to the victim's usual office address. Settings -> Account -> Sessions & activity, the administrator session console and the 'New device sign-in' notification (`_notify_session_event`) then show a familiar IP, which hides the intrusion from the very review these screens exist for.

**Proposed fix.**

Derive the session IP with the same trusted-proxy resolution the audit context uses (`audit.context` rightmost non-trusted entry, socket peer otherwise), or store both values and label the forwarded one as unverified.

**Skeptic's verdict (first paragraph).**

I confirmed this by reading the code and reproducing it. `session_metadata` (backend/app/api/deps.py:327-345) gets its IP from `state.client_ip_from` (backend/app/state.py:4323-4338). That function returns the first `X-Forwarded-For` entry with no trust check, whoever the socket peer is. The bundled nginx forwards with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` (webui/nginx.conf:21,46,67,80). That directive appends the real `$remote_addr` to whatever header the client sent, so the first entry is chosen by the caller. A caller that reaches backend port 8088 directly can set it outright.

**Skeptic's minimal fix.**

In backend/app/api/deps.py `session_metadata`, derive the IP with the audit context's trusted-proxy resolution instead of `client_ip_from`. Replace `from ..state import client_ip_from, geo_for_ip, parse_user_agent` / `ip = client_ip_from(request)` with `from ..audit.context import audit_client_ip` and `from ..state import geo_for_ip, parse_user_agent`, then `client = audit_client_ip(request)` and `ip = client.ip or ""`. `audit_client_ip` already falls back to the socket peer and returns None for a non-address peer.

Alternatively, make `state.client_ip_from` delegate to `audit_client_ip(request).ip or ""`, so no caller keeps the leftmost-entry behaviour, and update its docstring and the note at audit/context.py:24-26.

Add a regression test: log in with a forged `X-Forwarded-For` from an untrusted peer and assert that `GET /api/sessions` does not show the forged address. Add a second case through a trusted proxy and assert the rightmost untrusted entry is recorded.

### B23. A recovery code or TOTP code can be redeemed twice by concurrent requests

- Area: auth-security / MFA single-use
- Severity: low
- Location: `backend/app/api/routes.py:5127`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`mfa_verify` reads `user = await state.users.get(username)`, matches against the in-memory copy, then writes `mfa_recovery_hashes=remaining` or `mfa_last_step` with an unconditional `users.update` (routes.py:5111-5135). There is no compare-and-swap on the consumed hash or step. With a store whose `get` yields (PostgreSQL or Elasticsearch), two requests carrying the same code both pass the match before either update lands. `mfa_disable` also checks a recovery code without consuming it (routes.py:5377).

**Failure scenario.**

A captured recovery code (or a TOTP code replayed within the same step) submitted twice in parallel mints two independent sessions, although the code is documented as single-use and replay-rejected.

**Proposed fix.**

Consume the code inside one CAS mutation (`kv_mutate`/`put_if` style): remove the matched hash, or require `mfa_last_step < step`, and treat a lost race as a failure. Re-read and re-verify inside the mutation.

**Skeptic's verdict (first paragraph).**

I reproduced the main claim. In `mfa_verify` (backend/app/api/routes.py:5094-5135) the handler reads the user once (`state.users.get`, about line 5108) and checks the TOTP step or recovery hash against that in-memory copy. It then writes `mfa_last_step=step` (line 5121) or `mfa_recovery_hashes=remaining` (line 5132) through `UserStore.update` (backend/app/stores/users.py:279-306). `kv_mutate` serialises and CAS-guards the write itself, but the patch value was computed from the stale read, and nothing inside the mutation re-checks that the hash is still present or that the stored step is still below `step`. A lost race therefore still succeeds.

**Skeptic's minimal fix.**

Make the consume step the authority, inside one user-store mutation.

1. Add a method to `UserStore` (backend/app/stores/users.py) that runs under `self._mutate`, for example `consume_mfa(username, *, step: int | None = None, recovery_code: str | None = None) -> bool`. Its `apply` re-finds the user in the fresh entry list (the list `kv_mutate` reloads on each CAS attempt) and does one of two things:
   - TOTP: if `u.mfa_enabled` and `step > (u.mfa_last_step or 0)`, set `mfa_last_step=step` and `updated_at`, then return True. Otherwise return False and leave the list unchanged.
   - Recovery: find the index of a hash in the fresh `u.mfa_recovery_hashes` that matches `verify_recovery_code(recovery_code, h)`. If found, delete that entry, set `updated_at` and return True. Otherwise return False.

2. In `mfa_verify` (routes.py:5116-5133), keep the read-only pre-check against the snapshot as a fast path. Replace the two unconditional `state.users.update(...)` calls with `await state.users.consume_mfa(...)`, and set `method` only when it returns True. When TOTP consumption loses the race, fall through to the recovery path, then to the existing `auth.mfa_failed` 401. Because the mutator re-reads on every CAS retry, a parallel request that already took the step or hash makes the second request fail. Each code then yields at most one session.

`mfa_disable` needs no change, since it wipes all second-factor state. Add a regression test that runs two concurrent /auth/mfa/verify calls with the same recovery code and the same TOTP code on the SQLite state backend, and asserts statuses [200, 401].

### B24. Refresh-token rotation is never reachable: no sign-in issues a refresh token

- Area: auth-security / refresh rotation
- Severity: low
- Location: `backend/app/api/routes.py:4436`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Sessions get a refresh hash only through `_register_session(refresh_hash=...)` (routes.py:3919-3953), and none of its four callers passes one (routes.py:4101, 5168, 5338, 5593). `new_refresh_token()` is called only inside `/auth/refresh` itself (routes.py:4511). Every `find_by_refresh` therefore misses and the route answers `401 unknown_refresh`. The Console's `api.auth.refresh` (webui/src/lib/api.ts:863) posts no body (FastAPI answers 422) and nothing calls it. docs/administration/authentication.md ('Sessions') lists 'refresh-rotation checks', and the reuse-detection logic is untested end to end.

**Failure scenario.**

An operator or API client relying on the documented refresh rotation and theft detection gets 401 on every refresh. Reuse detection, which revokes all sessions on replay, can never fire.

**Proposed fix.**

Either issue a refresh token at the cookie-set sites (login, mfa/verify, enroll-confirm, sso/callback) and return it once, or remove the route and the dead client method and correct the documentation. Refresh rotation also re-keys the row (stores/sessions.py:508-536), so the old access token's sid becomes unknown and would be lazily re-registered by deps.py:250-262. Mark the old sid revoked when rotating.

**Skeptic's verdict (first paragraph).**

I could not refute it. Every part of the main claim holds, and I reproduced it.

**Skeptic's minimal fix.**

The smallest correct fix is to make the documentation and the API surface honest, rather than add a new credential that would be readable from browser JavaScript.

1. Correct the documentation in SECURITY.md (the "Refresh-token rotation & reuse (theft) detection" section), docs/USAGE.md §27 (remove the refresh paragraph and the curl line), DEPLOY.md:1158 and docs/administration/authentication.md:35. They should say that version 0.1.x issues no refresh tokens, that a session lasts until its access token expires (`AUTH_TOKEN_HOURS`, or the Remember me duration) within the idle and absolute limits, and that `POST /api/auth/refresh` is reserved and answers 401 `unknown_refresh`.
2. Delete the dead `refresh` method from `api.auth` in webui/src/lib/api.ts:860-863, with its comment.
3. Either keep the route and mark it `deprecated=True` in OpenAPI, or remove it together with its tests that rely on seeded rows. Then regenerate `api-types.gen.ts` with `check:types`.

If real refresh rotation is wanted instead, these steps are needed:
- At the four cookie-set sites (routes.py:4101, 5168, 5338, 5593), call `new_refresh_token()`, pass `refresh_hash=hash_refresh(tok)` to `_register_session`, and return the raw token only to bearer-token API clients. It should never go into a JSON body the SPA keeps, or it would be exposed to XSS. An HttpOnly, path-scoped cookie is the alternative.
- In `/auth/refresh`, revoke the old sid when rotating. For example, leave a revoked tombstone row for `old_sid` in `rekey_and_rotate`, or add the old sid to the revoked set. Otherwise deps.py:246-262 lazily re-registers the old access token.
- Add an end-to-end test that runs login, then refresh, then a replay of the old refresh token.

### B25. The sign-in page shows arbitrary attacker text from ?sso_error=

- Area: auth-security / login content injection
- Severity: low
- Location: `webui/src/soc/pages/Login.tsx:423`
- Owning package: WP04
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`const e = params.get('sso_error'); if (e) setError(`Single sign-on failed: ${e}`)` (Login.tsx:419-423) renders the raw query value. The backend only ever sends a closed set of codes (`missing_code_or_state`, `state_not_bound`, `invalid_state`, `unknown_provider`, `token_exchange_failed`, `incomplete_identity`, `not_allowed`, `audit_unavailable`, `user_not_provisioned`, `session_failed`; routes.py:5513-5590). React escapes the value, so this is text injection, not XSS.

**Failure scenario.**

A phishing link to the genuine Console, such as `https://soc.example/login?sso_error=Your+password+expired.+Re-enter+it+at+https://evil.example`, shows that sentence in the official sign-in card's error banner.

**Proposed fix.**

Map `sso_error` through a fixed dictionary of the backend's codes to fixed sentences and show a generic 'Single sign-on failed' for anything else.

**Skeptic's verdict (first paragraph).**

I could not refute it, and the code is as reported (HEAD 3cd362c). webui/src/soc/pages/Login.tsx:419-423 reads `params.get('sso_error')` from `window.location.search` when the page mounts and calls `setError(`Single sign-on failed: ${e}`)` with no check on the value. That string is rendered verbatim as the main line of the destructive Alert in the sign-in card (Login.tsx:813-821). It has no length limit, and it stays on screen until the user types or submits, because only `clearError()` call sites clear it. The page is reachable at any path: nginx falls back to index.html via `try_files $uri $uri/ /index.html` (webui/nginx.conf:117-119), and the effect reads the query string whatever the path is.

**Skeptic's minimal fix.**

In webui/src/soc/pages/Login.tsx, replace the free-text interpolation with a fixed lookup, keeping the URL cleanup:

const SSO_ERROR_MESSAGES: Record<string, string> = {
  missing_code_or_state: 'The identity provider did not return a sign-in code. Try again.',
  state_not_bound: 'This sign-in was started in another browser or tab. Try again from here.',
  invalid_state: 'This sign-in link expired. Try again.',
  unknown_provider: 'That single sign-on provider is not configured.',
  token_exchange_failed: 'The identity provider could not confirm the sign-in. Try again.',
  incomplete_identity: 'The identity provider did not share an email address.',
  not_allowed: 'Your account is not allowed to sign in here.',
  audit_unavailable: 'Sign-in is unavailable right now. Try again shortly.',
  user_not_provisioned: 'No account here matches your identity. Ask an administrator.',
  session_failed: 'The session could not be started. Try again.',
};
...
const e = params.get('sso_error');
if (e) {
  setError(
    Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, e)
      ? `Single sign-on failed. ${SSO_ERROR_MESSAGES[e]}`
      : 'Single sign-on failed.',
  );
  // existing searchParams.delete('sso_error') + replaceState unchanged
}

Use the own-property check so a value like `?sso_error=constructor` falls through to the generic message. Add a Vitest case: an unknown value such as `?sso_error=Your+password+expired` must render only "Single sign-on failed." and never the injected text, and each known code must render its fixed sentence.

### B26. SLA response clock keeps running on cases the agent closed, so every auto-close eventually counts as a permanent SLA breach

- Area: backend metrics: SLA attainment, plus the SOC operations, Executive summary and Standup SLA widgets
- Severity: high
- Location: `backend/app/engine/metrics.py:947`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

In sla_metrics, `resp_at = timings.resp_anchor or timings.resp_human` only counts human transitions. When it is None the code treats the case as 'still unresponded → live clock' (lines 949-952) even when the case is terminal. Repro with default Preferences(): one case (P4, status closed, decision_by agent, status_history new→closed by 'agent', created 22h ago) gives {'evaluated': 1, 'response_breached': 1, 'attainment_pct': 0.0, breaching: [{'clock': 'response', 'elapsed_minutes': 1320.0, 'target_minutes': 480.0}]}. Live demo: GET /api/metrics/posture returns response_breached 1 with CASE-000040 (auto-closed at creation, decision_by agent, first_response_at null) at elapsed 1355.3 vs a 480 target. The SOC operations board's 'SLA breaches and at risk' panel lists it as 'P4 CASE-000040 Response 14h 18m over' (screenshot <scratchpad>/round16/bugs/console-a/11-board-builtin_soc_operations.png).

**Failure scenario.**

The seeded demo has 31 demo_noisy_scanner cases the agent auto-closed at 19:38 UTC (P4, 480-minute response target). Around 03:38 UTC every one of them becomes a response breach that keeps growing, and the 24h SLA attainment falls from 97.4% to about 16%. In production, a P1 auto-close breaches after 15 minutes and stays breached forever. This contradicts the MTTA rule that an AI close is never a human response. It also inflates 'SLA breached', the SLA attainment figure on the Executive summary and Overview, and the breaching list.

**Proposed fix.**

When the case reached a terminal state (timings.terminal_any, or a terminal status with updated_iso) and has no response anchor, stop the response clock at the terminal instant, or exclude agent and policy closes from the response clock. Never apply the live 'now' clock to a terminal case. Add a regression test with an agent-closed case older than its target.

**Skeptic's verdict (first paragraph).**

The defect is real. I confirmed it in the code and reproduced it at HEAD 3cd362c.

**Skeptic's minimal fix.**

In backend/app/engine/metrics.py `sla_metrics`, work out the terminal instant before the response clock and stop the response clock there when there is no human response.

```python
status_val = c.status.value if c.status else ""
end = None
if status_val in _TERMINAL:
    end = timings.terminal_any or timings.updated_iso
resp_at = timings.resp_anchor or timings.resp_human
...
if resp_target > 0:
    stop = resp_at or end  # a closed case's clock stops at its close
    elapsed = ((stop or now) - start).total_seconds() / 60.0
    if stop is None:  # genuinely open and unresponded -> live clock
        ...breached / at_risk as today...
    elif elapsed > resp_target:  # responded, or closed, but late
        ...breached...
```

Then reuse the same `end` for the resolution clock. Taking `end` only when the current status is terminal also matches the `_resolved_dt` guard, so a reopened case's stale terminal entry no longer stops its clocks.

An agent or policy close within the target then counts as met, and one after the target counts as a fixed-size breach that never grows. MTTA and dwell stay human-only.

Add a regression test in backend/tests: an agent-closed P4 case created 22h ago and closed at creation should give `response_breached == 0` and `attainment_pct == 100.0`. An agent-closed P1 case closed 20 min after creation should give a 20-minute breach whose size does not change as `now` moves forward.

### B27. Case detail reads the deprecated prefs.fp_auto_close, so the facts rail and Investigation tab state the wrong auto-close policy

- Area: Case Manager / CaseDetail facts rail and Investigation decision section
- Severity: high
- Location: `webui/src/soc/pages/CaseDetail.tsx:1295`
- Owning package: WP03
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`setFpPolicy((res?.prefs?.fp_auto_close as FpPolicy) || null)` reads the dead legacy field. Round 5 R1 (settings/detection.tsx:8-14) moved the editor to prefs.auto_close because decide() reads only that field. Defaults: FpAutoCloseConfig enabled=False, min_confidence=0.95 (config.py:705-706). The effective AutoClosePolicy.false_positive is enabled=True at 0.85 (config.py:733-735). The demo settings match: prefs.fp_auto_close {enabled:false, min_confidence:0.95} and prefs.auto_close.false_positive {enabled:true, min_confidence:0.85}. On CASE-000034 (open, AI verdict FP 87%, risk 12) the Investigation tab shows 'FALSE_POSITIVE auto-closed: confidence 0.87 >= 0.85 and risk 12.0 <= 30.0' directly above 'False-positive auto-close is disabled.' (InvestigationPanel.tsx:97-107). The rail says 'Auto-close bar 95% · auto-close off' (FactsRail.tsx:129-135, shared.tsx:446-459). Screenshot: <scratchpad>/round16/bugs/console-a/08-policy-investigation-demo-00000539-0007.png. The same rail line appears on CASE-000046 (03-cm-details.png).

**Failure scenario.**

On every default install, an analyst opening any open case with a false-positive verdict is told that FP auto-close is off and the bar is 95%, while decide() closes FP cases at 85%. The analyst concludes the agent will not close such cases (or that an 87% case is below the bar), and reads a decision record that contradicts the line under it. The InvestigationPanel message at line 109 ('true-positive verdicts never auto-close') is also wrong once an operator opts in to TP auto-close.

**Proposed fix.**

Read prefs.auto_close and pass the per-verdict VerdictAutoClose (false_positive or true_positive by c.verdict; needs_human always off) to confidenceCalibration and autoCloseLine. Drop the fp_auto_close read. Add a test where fp_auto_close and auto_close disagree.

**Skeptic's verdict (first paragraph).**

I couldn't refute it. Every link in the chain checks out.

**Skeptic's minimal fix.**

In `webui/src/soc/pages/CaseDetail.tsx`, stop reading `prefs.fp_auto_close` and keep `prefs.auto_close` instead (already typed as `AutoClosePolicy` in `lib/types.ts:5718`/6085):

`setAutoClosePolicy((res?.prefs?.auto_close as AutoClosePolicy | undefined) ?? null);`

**Pick the right policy entry for the case's verdict.** Add one helper in `casedetail/shared.tsx`:

`policyForVerdict(p: AutoClosePolicy | null, verdict?: string): FpPolicy`

It should return:
- `p.false_positive` when the verdict is a false positive or benign
- `p.true_positive` when it is a true positive
- `{ enabled: false }` for needs-human or any other verdict (never auto-closes, enforced in code)

**Use the helper in both places.** In `FactsRail` `autoCloseBarLine` and in `InvestigationPanel` `autoCloseLine`, call it on `c.verdict` instead of hard-coding the FP-only wording:
- `confidenceCalibration` note: "auto-close enabled at this bar" when the entry is enabled, else "auto-close off".
- `autoCloseLine`: evaluate confidence and risk against the selected entry. Say true positives never auto-close only when `p.true_positive.enabled` is false. Keep the needs-human line unconditional.

**Smallest possible change.** Replacing line 1295 with `(res?.prefs?.auto_close?.false_positive as FpPolicy) || null` fixes the default-install false-positive case. It still misstates the true-positive opt-in.

**Add a test.** Give `CaseDetail`/`InvestigationPanel` a test where `fp_auto_close` is `{enabled:false, min_confidence:0.95}` and `auto_close.false_positive` is `{enabled:true, min_confidence:0.85}`. Assert that the rail shows "Auto-close bar 85%" and that "False-positive auto-close is disabled." does not appear.

### B28. Take action → Change owner and Edit tags open and immediately close (dead menu items)

- Area: Case Manager header / CaseDetail (embedded and Overview sheet)
- Severity: medium
- Location: `webui/src/soc/pages/CaseDetail.tsx:2004`
- Owning package: WP03
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The menu items call setOwnerOpen(true) (line 2095) and openTagsEditor() (line 2109) from onSelect. Both editors are non-modal Radix Popovers (CaseHeaderMeta.tsx:175, CaseTagsEditor.tsx:94), and in a narrow pane the tags editor is inside the non-modal Details Sheet. The DropdownMenuContent at line 2004 has no onCloseAutoFocus handler, so Radix returns focus to the Take action trigger after the item is selected, and the popover or sheet dismisses itself on focus-outside. Sampling the DOM every 100-150 ms after selecting the item: the Owner popover is present for the first samples and gone by about 450-600 ms, with focus on 'Take action'. 'Edit tags' opens the Case facts sheet and the Tags popover, then both close and focus lands on 'Details'. Reproduced at 1440 and 1920 wide in Case Manager and in the Overview case sheet. The M and T keys open the same editors and they stay open. Screenshots: <scratchpad>/round16/bugs/console-a/05-Change_owner-menu-1440.png and 05-Edit_tags-menu-1440.png. Round 15 SPEC D8.2 says 'Edit tags' opens the Details sheet first when the rail is hidden.

**Failure scenario.**

An analyst clicks Take action → Change owner (or Edit tags) to reassign or tag a case. The editor flashes for a fraction of a second, or not visibly at all, and nothing happens. Mouse users cannot reassign or tag from the menu; only the M/T shortcuts or the meta-row owner chip work.

**Proposed fix.**

Open these editors after the menu has finished closing. For example, record the pending editor in a ref and open it from DropdownMenuContent onCloseAutoFocus with event.preventDefault() (the pattern the dialogs use through actionOpenerRef), or defer setOwnerOpen and openTagsEditor with requestAnimationFrame. Add a browser-level regression test, since jsdom does not reproduce the focus-return dismissal.

**Skeptic's verdict (first paragraph).**

Confirmed in the code and reproduced in a live browser.

**Skeptic's minimal fix.**

In webui/src/soc/pages/CaseDetail.tsx, open these two editors only after the Take action menu has finished closing, and stop Radix from returning focus to the trigger:

1. Next to takeActionTriggerRef, add:
   `const pendingMenuEditorRef = React.useRef<'owner' | 'tags' | null>(null);`
2. On the Take action DropdownMenuContent (line 2004), add:
   ```tsx
   onCloseAutoFocus={(event) => {
     const editor = pendingMenuEditorRef.current;
     if (!editor) return;
     pendingMenuEditorRef.current = null;
     event.preventDefault(); // skips Radix's trigger.focus(), which dismissed the non-modal popover or sheet
     if (editor === 'owner') setOwnerOpen(true);
     else openTagsEditor();
   }}
   ```
3. In the "Change owner" onSelect, replace `setTakeActionOpen(false); setOwnerOpen(true);` with:
   `pendingMenuEditorRef.current = 'owner'; setTakeActionOpen(false);`
4. In the "Edit tags" onSelect, replace `setTakeActionOpen(false); openTagsEditor();` with:
   `pendingMenuEditorRef.current = 'tags'; setTakeActionOpen(false);`

When the editors close, the Owner popover returns focus to its owner-chip trigger, and the Details sheet's own onCloseAutoFocus already returns focus to Details.

Add a jsdom test: select each menu item, then use `await findByRole('dialog', { name: 'Owner' | 'Tags' })` (onCloseAutoFocus fires asynchronously). Add a browser-level check that the editor is still open about 500 ms after selection, because jsdom does not reproduce the focus-return dismissal.

I applied this change temporarily, verified it live at 1440 and 1920 wide with mouse and keyboard, and confirmed the existing CaseDetail.keyboard and FactsRail tests still pass.

### B29. KPI drill-down 'Source' column (and CSV) is blank for every alert-sourced case

- Area: Overview KPI drill-down (Deep inspection) and Export listed
- Severity: low
- Location: `webui/src/soc/components/KpiDrilldownPanel.tsx:1814`
- Owning package: WP12
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The column headed 'Source' renders c.detection_source (line 1825). Only the EVENT-feed funnel sets that field (backend/app/engine/event_detection.py:373 and 619). Every case in the demo listing has detection_source null and a source_name (for example 'Splunk Enterprise Security (HEC)'). The Total cases drill-down shows the dash placeholder in Source on all 38 rows (screenshot <scratchpad>/round16/bugs/console-a/20-drill-row.png), and the exported CSV agentic-soc-cases-total-cases-38-listed-*.csv has an empty detection_source column on every row.

**Failure scenario.**

An operator drilling into a KPI to see where cases came from sees the dash placeholder for every row and cannot tell which SIEM or EDR produced them. The source facet menu offers nothing for alert feeds. The label suggests the log source, but the field means detection|anomaly|rule.

**Proposed fix.**

Show source_name (falling back to source_id) in the Source column and CSV, and keep detection_source as a separate 'Detected by' value shown only when present. Or rename the column 'Detected by' and hide it when no row has a value.

**Skeptic's verdict (first paragraph).**

Confirmed, and it is worse than the report says. The drill-down's "Source" column (webui/src/soc/components/KpiDrilldownPanel.tsx:1814 header, :1825 and :1861 cell), the CSV column (drilldownCsv at :525/:539), the Source facet universe (:856) and the facet filter (:974) all read `Case.detection_source`. The report says only the EVENT-feed funnel sets that field. In fact no backend path ever writes it onto a Case. event_detection.py:373 and :619 set `detection_source` on the in-memory `CandidateAlert`, not on the Case. `results_to_candidates` (event_detection.py:557) returns `(cluster, detection_source)`, and its only consumer, state.py:2133, unpacks the value as `_src` and never stores it. It passes the cluster to `register_candidate` and `investigate_cluster`, which have no detection_source parameter. Its docstring at event_detection.py:517-518 claims "the case's detection_source is set by the pipeline", but nothing does that. A grep of backend/app finds `detection_source` only in event_detection.py, the models.py declaration (:1954, default None) and a chat-tool read. So `Case.detection_source` is always null, the Source column shows a dash on every row of every drill-down, and the CSV column is always empty. The Source facet is hidden (`sourceFacets.length ?` at :1572), so the filter is dead UI. The label also conflicts with the case detail facts rail (FactsRail.tsx:383, 389), where "Source" means `source_name` and `detection_source` is labelled "Detected by". The existing tests seed made-up values such as `detection_source: 'rule'` and `'Wazuh'` (overview.deepinspection.test.tsx:103, KpiDrilldownPanel.csv.test.ts:65), which hides the gap. The issue is not recorded in docs/releases/known-limitations.md, ROADMAP.md or the Round 15 SPEC. Severity stays low: the column carries no information, but nothing is wrong and no data is lost. I did not run the live demo: static tracing proves the field is never written, and the reporter's screenshot matches. The repo was left unmodified.

**Skeptic's minimal fix.**

In KpiDrilldownPanel.tsx, make "Source" mean what FactsRail means by it. The cell (:1825/:1861) should render `(c.source_name || c.source_id || '').trim() || DASH`, with the same value in the CSV. Add a `source_name` column to drilldownCsv, placed before `detection_source` so existing column consumers are not reordered, and populate it with `c.source_name ?? c.source_id ?? ''`. Build the facet universe (:856) and filter (:974) from that same `source_name || source_id` value, and update the doc comment at :1020-1027. Keep `detection_source` only as an optional "Detected by" value, shown only when some row has one. Update the CSV and deep-inspection tests so they seed `source_name` instead of a vendor name in `detection_source`. Optional backend follow-up, separate from this fix: state.py:2133 should carry `_src` onto the Case created by `register_candidate` so "Detected by" ever has a value. That loop also reads `getattr(_src, "id", None)` on a plain string, which is always None, so `query_source` is never resolved there.

### B30. Deleting or adding a screenshot writes raw machine text to case history, without the caption or filename the dialog promises

- Area: Case screenshots (Collaboration → Files) and case activity
- Severity: low
- Location: `backend/app/api/routes_case_files.py:627`
- Owning package: WP14
- Merged into: none
- Skeptic verdict: real

**Evidence.**

result_summary is f"file_deleted file={file_id}" (line 627) and f"file_attached file={file_id} type={image.kind} bytes={image.size}" (line 564). Collaboration → Show all activity renders these verbatim: 'file_deleted file=df219d9c37f9b7f0a0e44b18f679dba2', 'file_attached file=1bd838e791c1b042dced58454e8c12e3 type=png bytes=1234'. The delete confirmation (CaseFiles.tsx:549) says 'Its caption, who added it and when stay in the case history.', but no history row names the caption or the filename (multi2.png in the test).

**Failure scenario.**

After a teammate deletes a screenshot, the case history shows only a 32-hex id. No one can tell which image was removed or what its caption said, which contradicts the dialog's promise and the audit-trail intent.

**Proposed fix.**

Render file events in the activity feed with a human label ('Screenshot added: <caption or filename>', 'Screenshot deleted: <caption or filename>') read from the file index tombstone or from fields carried on the audit row. Never show the raw result_summary.

**Skeptic's verdict (first paragraph).**

I reproduced this, and it is a real low-severity defect. I could not refute it.

**Skeptic's minimal fix.**

This is a presentation-only fix; keep audit summaries free of captions and filenames.

1. In `webui/src/soc/components/caseActivityText.ts` `activityText()`, add two anchored patterns before the fallback. Each returns `plain(...)`, so the recorded text stays under Details:
   - `/^file_attached file=([0-9a-f]{32}) type=(png|jpeg|webp) bytes=(\d+)$/` → `Screenshot added (PNG, 107 B).`, using the type uppercased and the size formatted.
   - `/^file_deleted file=([0-9a-f]{32})$/` → `Screenshot deleted.`

   Optionally also give `kindMeta`/`activityKindLabel` a screenshot icon for these rows.

2. Keep the delete dialog's promise in one of two ways:
   - **Show the tombstones.** In `webui/src/soc/pages/casedetail/files/CaseFiles.tsx`, render the `deleted[]` entries already returned by `GET /api/cases/{id}/files`. Put them under a small collapsed "Deleted screenshots (n)" list showing caption or filename, who added it and when, and who deleted it and when, all as plain text nodes.
   - **Or change the copy.** Reword `CaseFiles.tsx:549` to promise only what is shown, e.g. "The image is removed from the case. The case activity keeps a record that it was added and deleted."

Add a unit test in the existing `caseActivityText` tests for both new summary shapes.

### B31. Choosing more screenshots than the remaining room silently drops the extras

- Area: Case screenshots upload (Collaboration → Files)
- Severity: low
- Location: `webui/src/soc/pages/casedetail/files/CaseFiles.tsx:463`
- Owning package: WP14
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`uploader.uploadFiles(picked.slice(0, room), caption)` discards every file past the remaining slots without reporting it. Choosing 7 PNGs on a case with 5 free slots (in-memory store limit 5): the status list reports multi1.png to multi5.png 'added to the case', and multi6.png and multi7.png are never mentioned. Only the generic 'This case has reached its screenshot limit' hint appears afterwards. The same applies to the 20-file production limit.

**Failure scenario.**

An analyst drags in a batch of screenshots, sees 'added to the case' messages, and believes all of them were saved. The last ones are silently missing from the evidence.

**Proposed fix.**

Add a status entry for each skipped file, for example '<name>: not added, this case already has N of N screenshots', or refuse the whole batch with a count before uploading.

**Skeptic's verdict (first paragraph).**

I confirmed this on the current tree (HEAD 3cd362c) and reproduced it with the production limit of 20.

**Skeptic's minimal fix.**

Keep the client-side cap, which avoids preparing images the server would refuse, and report each file it leaves out.

In useCaseFileUpload.ts, add a method to CaseFileUploader:
`skip: (files: readonly File[], message: string) => void`
It appends `{ key: nextKey(), name: file.name || 'Pasted image', status: 'error', message }` for each file. Return it alongside uploadFiles.

In CaseFiles.tsx onFiles:
```
const room = limits ? Math.max(0, limits.max_files - files.length) : picked.length;
const extra = picked.slice(room);
if (extra.length && limits) uploader.skip(extra, `not added. This case allows ${limits.max_files} screenshots.`);
void uploader.uploadFiles(picked.slice(0, room), caption).then(...);
```
The existing status list renders these as `<name>: not added. This case allows 20 screenshots.` in the aria-live region, styled `text-critical-text`.

Add a CaseFiles test: 15 existing files, drop 7, expect 5 uploads plus visible errors for multi6.png and multi7.png.

A one-line alternative is to drop the `.slice(0, room)` and let the server refuse the extras with `case_files_case_full`, as the close dialog already does. That spends a canvas encode and an upload request on every extra file, so the explicit skip report is better.

### B32. SLA countdown rounds to the nearest hour or day, overstating the time left

- Area: Case header meta row and facts rail SLA
- Severity: low
- Location: `webui/src/soc/pages/casedetail/caseFacts.ts:94`
- Owning package: WP11
- Merged into: none
- Skeptic verdict: real

**Evidence.**

shortDuration uses Math.round for minutes, hours and days, and caseFacts.ts:177 renders `${kind} due in ${shortDuration(left)}`. CASE-000046 (P3, 120-minute response target) opened 26 minutes earlier showed 'P3 · Response due in 2h' with 1h34m left. CASE-000045 (P4, 480 minutes) opened 29 minutes earlier showed 'Response due in 8h' with 7h31m left. The same rounding inflates 'overdue by' at the day scale (2.5 days → '3d').

**Failure scenario.**

A shift lead triaging by SLA reads 'due in 2h' and defers a case that will breach in about 1.5 hours. The rounding always errs in the direction that hides urgency.

**Proposed fix.**

Floor the remaining time for 'due in' (or show hours and minutes under a few hours) and ceil for 'overdue by', so the label never overstates the time left.

**Skeptic's verdict (first paragraph).**

I confirmed the defect in the code and reproduced it.

**Skeptic's minimal fix.**

In webui/src/soc/pages/casedetail/caseFacts.ts, give shortDuration a rounding function and floor the time left for "due in":

export function shortDuration(ms: number, round: (n: number) => number = Math.round): string {
  const abs = Math.abs(ms);
  const minutes = round(abs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = round(abs / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${round(abs / 86_400_000)}d`;
}

and in slaReading change the due-in line to `text: `${kind} due in ${shortDuration(left, Math.floor)}``. The overdue line can keep the default rounding or use Math.ceil. With Math.floor, 94 minutes left reads "1h" and 7h31m reads "7h", so the label never claims more time than remains. Add a caseFacts unit test asserting that 94 minutes left on a P3 renders "Response due in 1h".

### B33. LEEF push events of the same event type collapse to one id, so distinct events are dropped

- Area: backend ingest (LEEF receiver), seen on the Logs page
- Severity: high
- Location: `backend/app/connectors/receivers/formats.py:357`
- Owning package: WP15B
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_parse_leef_line stores the LEEF header EventID (which names an event type or QID, not one occurrence) as rec['event_id'] (formats.py:357). ocsf/identity.py:22-31 native_event_uid treats 'event_id' as the vendor's unique id, and source_scoped_event_uid then hashes only that native id with no ordinal (identity.py:63-64). The push spine dedups by that id twice: engine/ingest.py:815 dedup_by_id(ensure_push_event_ids(...)) on the batch, and ingest.py:872 against the buffered recent events. Scratch repro (scripts/pytests/test_cb_leef_ids.py under the scratchpad bugs folder): three LEEF lines with EventID 'LoginFailed' and different src and usrName parse to 3 events that share id push:b4f26fe41517:5fc284fdbe6c3e3b400e11888df8b39b; after ensure_push_event_ids+dedup_by_id only 1 is left. The CEF control keeps 2 of 2. Live demo: GET /api/logs?rule=LP-QR-0001&from=now-1h returned 12 QRadar rows with different IPs and times, and all 12 have id push:6d68f87e5ee2:e5a9ea8042b68970127e54224ec8ff5f (the Logs table aria-labels 'Show raw event for …' are identical; screenshot console-b/logs-06-rulefilter.png).

**Failure scenario.**

An operator forwards QRadar or another LEEF source through the syslog or webhook receiver. A burst of 50 'LoginFailed' events from 50 IPs in one delivery is cut to 1 event before correlation. Later events of the same type inside the correlation look-back are dropped as duplicates of the buffered first one. Threshold rules ('5 failures from one IP in 120 s') never fire, member_event_ids collapse, and the case evidence is missing most of the attack.

**Proposed fix.**

Do not let the LEEF header EventID act as a per-occurrence id: store it as leef_event_id or event_type (keep the rule mapping), or skip it in native_event_uid for LEEF records. Without a real per-event id, fall back to the canonical-record fingerprint plus ordinal. Add a receiver test that sends several same-EventID LEEF lines and expects every one to survive ingest.

**Skeptic's verdict (first paragraph).**

I reproduced the report through the real receivers. The bug is real.

**Skeptic's minimal fix.**

Stop the LEEF header EventID from acting as a per-event id, and keep the record shape. Keeping it matters because saved source mappings and the demo (demo_sources.py:723, "rule_field": "event_id") use rec["event_id"] as the rule, and test_receivers.py:153 asserts it.

In backend/app/ocsf/identity.py, make native_event_uid skip the "event_id" path for LEEF records:

```python
def native_event_uid(record):
    paths = _NATIVE_ID_PATHS
    if "leef_version" in record:  # LEEF header EventID names an event TYPE/QID, not an occurrence
        paths = tuple(p for p in paths if p != "event_id")
    for path in paths:
        ...
```

A LEEF record then takes the same fallback as CEF and syslog: a hash of the canonical record plus its ordinal, which stays stable when the same payload is retried in the same order.

The other option is to rename the parsed key in formats.py:357 to "leef_event_id" (and set "signature_id" so the rule aliases find it), then update the demo rule_field and the test. Saved mappings that use "event_id" would need a migration.

Add a regression test in backend/tests/test_receivers.py:
- send three same-EventID LEEF lines with different src values through WebhookReceiver (format_hint=leef) and through IngestService.ingest(..., source_id=...);
- assert there are 3 distinct ids and received == 3;
- assert two separate deliveries of the same type inside the look-back both reach correlation.

### B34. Rule 'Test and preview' ignores Demo Mode: it reads the real tenant sources

- Area: Detection & rules > Test and history (POST /api/rules/preview)
- Severity: medium
- Location: `backend/app/api/routes_rules.py:841`
- Owning package: WP15D
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_read_recent_events iterates state.prefs.sources and state.ingest_service (routes_rules.py:841-853) and has no state.demo_active branch. GET /api/logs switches to demo_browse_targets(state.demo_sources_overlay(), …) when demo is active (api/routes.py ~1600). Scratch repro (scripts/pytests/test_cb_preview_demo.py): with a real Elasticsearch source holding 6 brute_force events and Demo Mode enabled, GET /api/logs returns 200 demo rows and 0 real rows. POST /api/rules/preview returns scanned=6 matched=6 with a real sample row {source_ip:'10.0.0.5', user:'root', host:'web01', message:'brute_force login failure…'}. In the live seeded demo, preview returns scanned 0 for Last 24h, 7 days and 14 days ('No events in this window to test against. Try a longer window.', console-b/rules-06-14d.png), while Logs shows 83 events in the last hour.

**Failure scenario.**

(1) Anyone evaluating the product in Demo Mode finds the rule preview always empty and is told to try a longer window, which never helps. (2) On a deployment with real sources, a person using Demo Mode (for example a demo to a prospect) runs a preview and sees real tenant log rows: user names, IPs, hosts and messages. That breaks the Demo isolation every other read path enforces.

**Proposed fix.**

Mirror GET /api/logs: when state.demo_active, read through demo_browse_targets / state.demo_source_connector and never touch state.prefs.sources. Add a test that a Demo Mode preview never returns a real-source row and does count demo rows.

**Skeptic's verdict (first paragraph).**

I could not refute it, and I reproduced it myself. `_read_recent_events` (backend/app/api/routes_rules.py:801-870) builds its targets only from `state.prefs.sources` and `state.ingest_service` (the loop at line 841), and it has no `state.demo_active` branch. `state.prefs` is the persisted tenant configuration. Demo sources never go into `Preferences.sources` (state.py:3993-4000), so in Demo Mode the preview reads the real tenant sources and none of the demo sources. Every sibling read path changes path in Demo Mode:
- GET /api/logs uses `demo_browse_targets(state.demo_sources_overlay(), ...)` (api/routes.py:1600-1605). It also returns 404 for a real source id, so a demo session cannot even tell whether a tenant source exists.
- GET /api/rules/summary uses a demo plan (routes_rule_summary.py:265-268, 407-408).
- /sources, /sources/health and /sources/coverage use the demo overlays.

**Skeptic's minimal fix.**

At the top of `_read_recent_events` in backend/app/api/routes_rules.py, before anything touches `state.prefs.sources`, add a Demo Mode branch that reuses the shared GET /api/logs demo reader:

```python
if state.demo_active:
    from ..engine.log_rows import browse_query, demo_browse_targets, fan_out
    targets = demo_browse_targets(
        state.demo_sources_overlay(),
        prefs=state.prefs,
        demo_source_connector=state.demo_source_connector,
        source_id=(body.source_id or None),
    )
    envelope = await fan_out(
        targets,
        browse_query(limit=int(body.limit), time_from=body.from_, time_to=body.to),
        per_source_timeout=8.0,
    )
    return envelope.get("logs") or []
```

The rows keep `_raw` through `log_row`, so the predicate evaluation and `_preview_row` work unchanged. A non-demo `source_id` then matches nothing in Demo Mode, and no tenant source is ever read.

Add a regression test to backend/tests/test_routes_rules.py: configure a real Elasticsearch source with events, enable seeded Demo Mode, then check that POST /api/rules/preview (a) never returns a real-source row in `sample`, (b) reports scanned > 0 from the demo sources, and (c) a scope to a real source id scans 0.

Optionally, replace the tenant half of the function with `tenant_browse_targets` + `fan_out`, the same way GET /api/logs does it, so the two paths cannot drift again.

### B35. Seeded Demo raises two CRITICAL agent-health alerts because the demo precedent corpus is never projected

- Area: Shell bell / agent health, Knowledge corpus page (Demo Mode)
- Severity: medium
- Location: `backend/app/api/routes_diagnostics.py:1473`
- Owning package: WP15D
- Merged into: none
- Skeptic verdict: real

**Evidence.**

With DEMO_MODE=seeded, GET /api/diagnostics/health returns demo_active:true and two alerts with severity 'critical': 'precedent_corpus_starved' ('0 analyst-confirmed precedents available') and 'precedent_projection_deficit' ('the corpus holds 0 analyst-confirmed precedent document(s) but the case history qualifies 33 record(s)…'; the remediation says the projection is broken and asks to rebuild the corpus and check the embedding provider). The bell shows an amber warning on every page, and a live announcement 'Agent health needs attention: …' fires (console-b/km-bell-health.png). The demo seeds analyst-confirmed outcomes (posture analyst_confirmed_fp=30), but the Knowledge page shows 'Resolved cases 0 docs' with the copy 'Resolved cases are indexed automatically when a case closes' (console-b/km-knowledge.png). GET /api/rag/stats in demo: by_source {runbook:51, mitre:8, suppression:3}, no resolved_case. Not listed in known-limitations.md or ROADMAP J.

**Failure scenario.**

A first-time user starts the one-command demo. Every page shows a critical health warning that the precedent projection is broken, and the Knowledge page contradicts its own copy. The demo looks broken, and the warning teaches people to ignore critical health alerts.

**Proposed fix.**

Have demo enable/seeding project the seeded analyst-confirmed cases into the demo's isolated corpus as resolved_case precedents (the same projection the real stack runs). If that is not wanted, have diagnostics report an explicit 'demo' status and not raise critical alerts while demo_active.

**Skeptic's verdict (first paragraph).**

I reproduced the defect. In seeded Demo Mode, GET /api/diagnostics/health raises two critical alerts that are false.

**Skeptic's minimal fix.**

The fix is in `backend/app/state.py`, in `_enable_demo_unlocked`.

1. Move the eager demo corpus seed (the try block around `await demo_stack.rag_service.ensure_seeded()` at line ~3615) to after every seeded case is saved, before the stack is committed. A good spot is after `await self._seed_demo_auto_close_reviews(...)` (line ~3731), or just before `await self.mutate_prefs(... {"demo": new_demo})` (line ~3798).
2. Keep it fail-open, as the existing try/except already is. The first projection then includes the 33 analyst-confirmed seeded cases as `resolved_case` precedent, the same projection the real stack runs.
3. Update the comment so it matches the new order.
4. Add a regression test: enable seeded demo, then assert that `/api/diagnostics/health` alerts contain neither `precedent_corpus_starved` nor `precedent_projection_deficit`, and that `/api/rag/stats` `by_source` includes `resolved_case`.

Moving the call is enough. A single call made after the saves never hits the `_seeded`/signature short-circuit, and the stack is still fully seeded before the atomic swap, so the Knowledge page is populated on first paint.

### B36. Automation proposals show a made-up '50% confidence' labelled as the agent's confidence

- Area: Approvals
- Severity: low
- Location: `backend/app/engine/threshold_automation.py:449`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Proposal(..., confidence=float(payload.get('confidence', 0.5) or 0.5)) at threshold_automation.py:449. Automation rule actions carry no confidence, so every automation proposal gets 0.5 (and an explicit 0 also becomes 0.5 through 'or 0.5'). Approvals.tsx:377-389 renders it as a '50% confidence' pill with the tooltip 'The agent's confidence in this recommendation'. Live: both demo 'Automation review / Operator acknowledgement' items show '50% confidence' (console-b/appr-01.png, appr-03-all-approved.png).

**Failure scenario.**

A reviewer reads '50% confidence' as the AI's real uncertainty about an acknowledgement checkpoint that no model scored, and gives the request a different priority because of it. This conflicts with the product's 'every number is real and verifiable' contract.

**Proposed fix.**

Leave confidence unset (None) for automation-drafted proposals and hide the pill when it is absent (or for automation_ack). Use the payload value only when it was really supplied, without the 'or 0.5' coercion.

**Skeptic's verdict (first paragraph).**

I confirmed the bug by reading the code. It is not recorded in known-limitations.md, ROADMAP section J or Round 15 SPEC section 8.3.

**Skeptic's minimal fix.**

Backend, `threshold_automation.py:449`: stop inventing a value. Use the payload value only when a real number was supplied:

`c = payload.get("confidence"); confidence = float(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else 0.0`

Drop the `or 0.5`. `Proposal.confidence` stays a float, so the wire shape and the generated types do not change.

Webui, `Approvals.tsx:478`: show the pill only where an agent really scored the proposal. Gate it as `{proposal.created_by === 'agent' ? <ConfidencePill confidence={proposal.confidence} /> : null}`, or equivalently hide it for `kind === 'automation_ack'` and `kind === 'tuning'`. This also stops the tuner's fixed 0.5 and 0.0 values (`threshold_tuner.py:1622` and `:1750`) from appearing as an agent's confidence.

Add a Vitest case: an `automation_ack` proposal with confidence 0.5 renders no "confidence" pill, while an agent suppression proposal still does.

### B37. An approved proposal shows a 'Retry approval' button and still says 'Expires in 1mo'

- Area: Approvals (All view)
- Severity: low
- Location: `webui/src/soc/pages/Approvals.tsx:671`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The approve-button label checks decisionIntent === 'approve' → 'Retry approval' before it considers `decided` (Approvals.tsx:671-679). decision_intent stays 'approve' after a successful approval, so the decided card shows a disabled 'Retry approval' and a disabled 'Reject'. The expiry chip still says 'Expires in 1mo', and the card does not say who approved or when. Repro: Acknowledge the CASE-000047 item, then switch to All (console-b/appr-03-all-approved.png; buttons ['Reject[disabled]','Retry approval[disabled]']).

**Failure scenario.**

An analyst reviewing history sees 'Retry approval' on an item marked Approved and concludes the approval failed or is half-applied.

**Proposed fix.**

When decided, render a read-only footer ('Approved by X at T' or 'Rejected …') instead of action buttons. Show the 'Retry …' labels only when approval_error is set, and hide the expiry chip for decided items.

**Skeptic's verdict (first paragraph).**

The defect is real. I confirmed it in the code, reproduced it with a test and checked the screenshot.

**Skeptic's minimal fix.**

In webui/src/soc/pages/Approvals.tsx (ProposalRow):

1. Check `decided` before `decisionIntent` in both button labels. A decided card should not show Retry labels.
   - Approve label: `busy ? 'Working…' : applying ? 'Resume approval' : !decided && decisionIntent === 'approve' ? 'Retry approval' : band === 'automation_ack' ? 'Acknowledge' : 'Approve'`.
   - Reject label: `applying && decisionIntent === 'reject' ? 'Resume rejection' : !decided && decisionIntent === 'reject' ? 'Retry rejection' : 'Reject'`.
   - Better still, when `decided`, replace the action row with a read-only footer such as `{status === 'approved' ? (band === 'automation_ack' ? 'Acknowledged' : 'Approved') : 'Rejected'}{proposal.decided_by ? ` by ${proposal.decided_by}` : ''}{proposal.decided_at ? ` ${humanizeAge(proposal.decided_at)}` : ''}`, with `title={formatTimestamp(proposal.decided_at)}` so the full time shows on hover. Also show `decision_reason` when it is set.

2. Render the expiry chip only for open items. Change line 486 to `{proposal.expires_at && !decided ? (`.

3. Add a vitest for an approved proposal and a rejected one, each with `decision_intent` set. The approved card must not contain 'Retry approval' and the rejected card must not contain 'Retry rejection'. Neither card shows 'Expires'. Each card shows the decider.

No backend change is needed. `decision_intent` must persist because it is the idempotent recovery state for the claim.

### B38. Conversation export claims 'Sources queried: Splunk…' for answers that queried no log source

- Area: Workspace chat > Conversation actions > Export (Markdown/HTML/Print)
- Severity: low
- Location: `webui/src/soc/chat/report/model.ts:493`
- Owning package: WP15G
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The conversation export builds item scope.sources from uniq([message.source_name, response?.effective_source_name]) (model.ts:493). routes_chat.py:2104-2108 sets effective_source_name to the default chat source connector for every non-command turn, whether or not a log tool ran. The exported shift brief (console-b/conv-agentic-soc-conversation-shift-brief-20261124-2026Z.md) says 'Answer · Sources: Splunk Enterprise Security (HEC)' and, under Methodology, 'Sources queried: Splunk Enterprise Security (HEC)'. Its own lookups line reads 'Built the shift snapshot; Read SOC metrics; Listed campaigns', which are all case-store reads. The server-side report saved from the same conversation has scope.sources [] (GET /api/reports/{id}).

**Failure scenario.**

An auditor or manager reads an exported brief that says a SIEM was queried when none was. The two exports of the same answer contradict each other.

**Proposed fix.**

Name a source only when a log-reading step actually ran against it (use step.sources, as the block path at model.ts:576/587 does), or have the backend set effective_source_name only when a log tool was called.

**Skeptic's verdict (first paragraph).**

The defect is real. I reproduced it.

**Skeptic's minimal fix.**

In `buildConversationDoc` (webui/src/soc/chat/report/model.ts, around line 493), use the server's `_scope_for` rule instead of always crediting the turn's source:

```ts
const LOG_TOOLS = new Set(['search_logs', 'log_stats']);
const toolSteps = (response?.steps ?? []).filter((s) => s.kind === 'tool');
const stepSources = uniq(toolSteps.flatMap((s) => s.sources ?? []));
const sources = stepSources.length
  ? stepSources
  : toolSteps.some((s) => LOG_TOOLS.has(s.tool ?? ''))
    ? uniq([response?.effective_source_name, message.source_name])
    : [];
// scope: { ..., sources, ... }
```

Then the item scope and `doc.sources` name a log source only when a lookup actually read it, as `routes_reports._scope_for` already does. Add a model.test.ts case: an answer with only `shift_snapshot`/`metrics` steps gives no "Sources queried" line, and a `search_logs` step without recorded sources credits the effective source.

### B39. Shift-brief 'Needs attention' list has no created time, so its 'Created (UTC)' export column is always blank

- Area: Workspace chat shift brief block and its exports
- Severity: low
- Location: `backend/app/agents/chat_tools/cases.py:1470`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The shift-snapshot case_list artifact items carry case_id, case_number, title, severity, verdict, status and risk, but no created_at (cases.py:1469-1478). Other case_list producers include it. The exported table keeps the 'Created (UTC)' header with an empty cell in all 10 rows (conv-agentic-soc-conversation-shift-brief-20261124-2026Z.md, 'Needs attention' table). In the app these rows show no age, while every other case list shows '5m ago'.

**Failure scenario.**

A shift handoff brief gives no age for the overdue cases it tells the next analyst to work first, and the Word, Excel and Markdown exports carry an empty column.

**Proposed fix.**

Add 'created_at' (iso) to each shift-snapshot queue item, as the search_cases rows do. Otherwise, drop the column when no row has a value.

**Skeptic's verdict (first paragraph).**

I confirmed this by reading the code and running a repro. The shift snapshot tool builds its "Needs attention" case_list items at backend/app/agents/chat_tools/cases.py:1469-1478 from case_id, case_number, title, severity, verdict, status and risk only. It has nothing to read a time from, because the attention_queue rows built at backend/app/engine/shift_report.py:217-232 carry only age_minutes and no creation timestamp. The other real case_list producer is search_cases, which uses common.case_list_item (backend/app/agents/chat_tools/common.py:1463), and that one does include created_at.

**Skeptic's minimal fix.**

Carry the case's creation time through the queue row and the artifact item. Both changes are additive.
1) backend/app/engine/shift_report.py, attention_queue row (around line 230): add "created_at": getattr(case, "created_at", None) or None. This is the same field common.case_list_item uses. The /api/standup and dashboard consumers ignore unknown keys, so the extra key is safe.
2) backend/app/agents/chat_tools/cases.py:1471-1477, shift-snapshot "Needs attention" item: add "created_at": iso_or_none(q.get("created_at")). iso_or_none is already imported at cases.py:45.
Optionally, add "created_at" to the observation's "attention" rows for parity. Add a regression test asserting that the shift_report case_list item has created_at for a dated case.

### B40. 'Delete conversation?' always says 'Its report stays in Reports', even with no report

- Area: Workspace chat history rail
- Severity: low
- Location: `webui/src/soc/pages/Chat.tsx:90`
- Owning package: WP15G
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The description is the fixed string `“${item.title}” and its saved messages will be removed. Its report stays in Reports.` Repro: delete the 'Shift brief' conversation, which never had a report; the dialog still says 'Its report stays in Reports.'

**Failure scenario.**

The user goes to Reports to find a report that never existed, or thinks deleting the conversation created one.

**Proposed fix.**

Add the sentence only when the conversation has a saved report (the rail or the report index already knows this). Otherwise say nothing about reports.

**Skeptic's verdict (first paragraph).**

The defect is real, and it is low severity.

**Skeptic's minimal fix.**

In webui/src/soc/pages/Chat.tsx, add the report sentence only when the row has a report, for example `description: `“${item.title}” and its saved messages will be removed.${item.report_id ? ' Its report stays in Reports.' : ''}``. Then update webui/src/soc/pages/__tests__/Chat.test.tsx:
- The 'confirms a delete and keeps the report' test should pass `{ report_id: 'rep-1' }` for that row and keep its assertion.
- Add a test that the dialog for a conversation without a report (like `c-older` as it is now) does not contain 'Its report stays in Reports'.
Optionally make the matching notes say "when the thread has one": ui-standard.md:971 and the comment at useChatConversations.ts:336.

### B41. Demo chat answers a free-text 'need attention first' question with closed, low-risk false positives

- Area: Workspace chat (Demo planner)
- Severity: low
- Location: `backend/app/engine/demo_chat.py:4983`
- Owning package: WP15D
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Asked 'Which of the cases opened in the last 24 hours need attention first?', the Demo answer lists CASE-000048/49/50 'demo_noisy_scanner (low, false positive, risk 16, closed)' and a table of 10 closed scanner cases. The same report shows 'Still open 5' (console-b/dl-agentic-soc-report-case-list-last-24-hours-20261124-2000Z.md). The starter version of the same question ('Which of the 37 cases opened since 11:54 need attention first?') correctly ranks the open cases by risk (CASE-000044 risk 88, CASE-000043, CASE-000046).

**Failure scenario.**

A prospect types the natural version of the headline question in the demo and is told to attend to closed noise first. The product looks like it cannot prioritise.

**Proposed fix.**

Route 'need attention / first / priority' phrasing to the same open-first, risk-ranked plan as the new_cases starter (_plan_new_since or _plan_shift_queue) instead of the generic newest-first case search.

**Skeptic's verdict (first paragraph).**

I reproduced it at HEAD 3cd362c. The line number in the report is off, but the defect is real.

**Skeptic's minimal fix.**

In backend/app/engine/demo_chat.py, add a prioritisation cue next to _RISK_RANK_RE:

_ATTENTION_RE = re.compile(r"\bneeds?\s+(?:\w+\s+)?attention\b|\bprioriti[sz]\w*\b|\bmost urgent\b|\b(?:work on|look at|start with|handle|tackle)\b[^.?!]{0,20}\bfirst\b")

Then in _cases_filters, extend the sort branch so these questions rank open cases by risk, without overriding a status or sort the question names itself:

    elif _RISK_RANK_RE.search(low) or _ATTENTION_RE.search(low):
        if _ATTENTION_RE.search(low) and "status" not in inp and "status_group" not in inp:
            inp["status_group"] = "active"   # attention means still-open work
        lowest = re.search(r"\b(?:lowest|least)[- ](?:risk|risky)\b", low)
        inp.update({"sort_field": "risk_score", "sort_order": "asc" if lowest else "desc"})

The oldest/waiting branch above it keeps its precedence. Add a planner test: classify("Which of the cases opened in the last 24 hours need attention first?") must plan search_cases with status_group="active", sort_field="risk_score" and window="now-24h", and the e2e answer must lead with an open case rather than a closed false positive.

### B42. Chat citation chip shows the internal case id instead of the case number

- Area: Workspace chat answer 'Sources N' citations
- Severity: low
- Location: `webui/src/soc/chat/message`
- Owning package: WP15G
- Merged into: none
- Skeptic verdict: real

**Evidence.**

On the CASE-000043 answer, the 'Sources 1' expander lists 'C11 Case · demo-recent-00000539-0001 user:vpatel · LP QRadar: impossible travel authentication' (console-b/chat-sources-01.png). Everywhere else the case is shown as CASE-000043.

**Failure scenario.**

An analyst cannot match the citation to the case named in the answer, or pastes the internal id into case search and gets nothing.

**Proposed fix.**

Render the citation with case_number when the citation carries it (or resolve it from the answer's case artifacts), and keep case_id only for the link target.

**Skeptic's verdict (first paragraph).**

Confirmed from the code and the screenshot. The backend's only case-citation producer, backend/app/agents/chat_tools/cases.py:936-943 (get_case), builds `Citation(id=..., kind="case", title=case.title or case.case_id, case_id=case.case_id, untrusted=True)`. The Citation model at backend/app/models.py:3429-3441 has no case_number field, so the human-facing number (Case.case_number, models.py:1875-1878, e.g. "CASE-000043") never reaches the client. On the client, ChatCitation (webui/src/lib/types.ts:3335-3346) and normaliseCitation (webui/src/soc/chat/stream-events.ts:566-590) have no number either. SourcesDisclosure.tsx:50-63 therefore labels the case button with `{caseId}`, the raw internal id.

**Skeptic's minimal fix.**

Carry the display number as an additive, optional field and render it like CaseRefText.
(1) backend/app/models.py Citation: add `case_number: str | None = Field(default=None, max_length=200)` and pass it through display_text in `_sanitise`.
(2) backend/app/agents/chat_tools/cases.py:938: pass `case_number=(case.case_number or None)` when building the case Citation.
(3) webui/src/lib/types.ts ChatCitation: add `case_number?: string | null`.
(4) webui/src/soc/chat/stream-events.ts normaliseCitation: add `case_number: optText(raw.case_number, 200)`. This is display text only; navigation still uses case_id.
(5) webui/src/soc/chat/message/SourcesDisclosure.tsx:52-63: label the button with `citation.case_number?.trim() || caseId`, add `title={caseId}`, and keep `onOpenCase(caseId)` as the link target. Stored transcripts without the field fall back to the id as they do today.
(6) Add a backend test that the get_case citation carries case_number, and a SourcesDisclosure test that the number is shown and the id is the target. Run check:types so types.ts matches models.py.

### B43. Setup wizard in Demo Mode writes demo sources into the live source configuration (Make primary / Edit)

- Area: Setup wizard (Settings > Re-run setup wizard), Data sources step
- Severity: high
- Location: `webui/src/soc/pages/Wizard.tsx:1052`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

In Demo Mode GET /api/sources returns only the demo overlay (backend/app/api/routes.py:958-959, every row has "demo": true), and the Sources page guards them (Sources.tsx:351, 935 'Managed by Demo Mode'). The wizard's Data sources step renders Edit, Remove and Make primary for the same demo rows with no s.demo check (Wizard.tsx:1219-1260; screenshot console-c/wizard-1.png). Make primary calls api.upsertSource with the overlay row (Wizard.tsx:1052-1070); SourceEditor.onSave (components/SourceEditor.tsx:1584-1617) is not demo-guarded either (only Test is). upsert_source (routes.py:999) has no demo guard. Reproduced on my isolated instance with the exact payload the button sends: POST /api/sources {id:'demo-wazuh', source_type:'wazuh', is_primary:true, ingest_mode:'push_http', config:{protocol,format}} -> 200, then GET /api/settings prefs.sources = [('demo-wazuh','Wazuh Manager (endpoint telemetry)', enabled True, primary False)] while GET /api/sources still shows only the overlay; audit row 'source.created added source demo-wazuh'. Remove on a demo row answers 404 'Source not found'. (Reverted with DELETE afterwards.)

**Failure scenario.**

An admin presenting Demo re-runs the wizard and clicks Make primary on 'Wazuh Manager (endpoint telemetry)'. Nothing visibly changes (the overlay still shows it non-primary), but a real, enabled push_http Wazuh source with demo-only config is now in the live configuration, hidden while Demo is on. On Exit & clear (which promises to restore real state exactly) the phantom source appears in the live Sources list. Remove on the same rows fails with a raw 404.

**Proposed fix.**

Treat source.demo rows in the wizard like the Sources page: hide or disable Make primary, Edit and Remove with the DEMO_MANAGED_REASON. Server side, refuse POST/DELETE /api/sources for a demo-* id (or any write) while demo_active with a 409, as runbooks do with runbook_demo_readonly.

**Skeptic's verdict (first paragraph).**

Confirmed by code reading and an in-process reproduction.

**Skeptic's minimal fix.**

The fix has two parts.

1. Frontend, webui/src/soc/pages/Wizard.tsx SourcesStep row actions (~1217-1260):
   - Skip demo rows like the Sources page does. When `source.demo` is true, render no Make primary, Edit or Remove buttons. Show a muted "Managed by Demo Mode" label instead, the same `DEMO_MANAGED_REASON` wording as Sources.tsx:127.
   - Also make `setPrimary`, `setEditing` and `remove` return early when `source.demo`.

2. Backend, defense in depth, in backend/app/api/routes.py:
   - Applies to `upsert_source` (POST /sources), `delete_source` (DELETE /sources/{id}) and `set_source_secrets`.
   - Refuse a write to a demo overlay id while Demo is active, and only that id. Real-source adds stay allowed in Demo, since the wizard explicitly offers them.
   - Insert at the top of each handler:
```python
from ..engine.demo_sources import DEMO_SOURCE_SPECS
if state.demo_active and source_id in {s.source_id for s in DEMO_SOURCE_SPECS.values()}:
    raise HTTPException(status_code=409, detail="source_demo_readonly")
```
   - Use `body.id` in `upsert_source` and the path id in the other two.
   - Add a regression test: enable demo, post the demo-wazuh payload and expect 409, then disable demo and expect `prefs.sources` to be unchanged.

### B44. Browser Back (or a typed hash) silently discards an unsaved Settings draft

- Area: Settings (all sections) / router navigation blocker
- Severity: medium
- Location: `webui/src/soc/router.tsx:557`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The blocker list is consulted only in navigate() (router.tsx:541-552). The hashchange handler (router.tsx:557-606) never reads blockersRef. Live: from #/team open Settings > Data scope, change Poll interval 30 -> 45 ('1 unsaved change' bar shows); clicking Sources in the sidebar correctly asks 'Leave Settings with unsaved changes?', but pressing Back twice lands on #/team with no prompt (h1 'Team activity'), and returning to Settings shows Poll interval 30 (draft lost). Same when setting location.hash directly. ROADMAP only records the dashboard-board variant ('a history guard so unsaved board edits survive browser Back'), not Settings, whose draft also holds secret drafts.

**Failure scenario.**

An operator edits several Settings sections (shared draft, plus a typed secret), presses the browser Back button out of habit, and every change is thrown away without the confirmation the in-app navigation shows.

**Proposed fix.**

In the hashchange handler, when a blocker applies and the new page differs, restore the previous hash (history.forward() or replaceHash(previous)) and open the same ConfirmDialog; continue to the target only on confirm. Add a beforeunload guard for reload/close while Settings is dirty if not already present.

**Skeptic's verdict (first paragraph).**

Confirmed by reading the code and by a throwaway Vitest reproduction, which I have since deleted (git status --short is empty).

**Skeptic's minimal fix.**

In RouterProvider (webui/src/soc/router.tsx), keep a `committedHashRef` set to the accepted hash. Update it at the end of `commitNavigation` and at the end of each accepted `onHashChange` pass, and seed it from the boot hash.

In `onHashChange`, after `route` is resolved and before `setPage`, when the change is not this router's own echo (`!own`), choose a blocker with the same filter `navigate()` uses: leaving = `route.page !== pageRef.current`, changing = `hash !== committedHashRef.current`, `.filter(b => leaving || (changing && b.sameRoute === true)).at(-1)`. If one applies:
1. Put the guarded URL back without firing another `hashchange`: `history.pushState(history.state, '', '#' + committedHashRef.current.replace(/^#/, ''))`. To keep history exact, record an index in `history.state` and call `history.go(delta)` instead.
2. If `pendingRef.current` is not already true, set it and call `setPendingNavigation({ page: route.page, opts: route.opts, blocker })`.
3. Return without calling `setPage` or `setOpts`.

The existing ConfirmDialog's confirm path already calls `commitNavigation(page, opts)`, which writes the target hash. Cancel leaves the restored Settings URL in place.

Update the `useNavigationBlocker` doc comment so it no longer says Back and Forward cannot be paused. Add a router test: with a blocker registered, set `location.hash` and dispatch `hashchange`. The page stays put and the dialog shows. Confirm lands on the target and cancel keeps the original hash. `beforeunload` is already covered by `useUnsavedChanges` and needs no change. The same change also closes the ROADMAP section I board item, because `sameRoute` blockers go through the same filter.

### B45. Two 'organization default theme' controls store different values and show contradictory state

- Area: Settings > Appearance (Organization default theme) vs Settings > Branding (Default theme)
- Severity: medium
- Location: `webui/src/soc/components/CustomizationSection.tsx:349`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Appearance shows 'Organization default theme: System' (reads/writes PUT /api/prefs/org default_theme, CustomizationSection.tsx:98,115,164; GET /api/prefs/org -> default_theme 'system'). Branding shows 'Default theme: Dark' selected (BrandingEditor.tsx:745; GET /api/branding -> default_theme 'dark'), which is what actually applies (theme-tokens.ts:472-479 effectiveBrandingTheme; install docs: fresh install opens dark, 'the organization default'). The backend merges the prefs/org value first (stores/user_prefs.py:312-314: a non-system org default_theme wins as theme_mode). Screenshots console-c/customization.png and console-c/branding-default-theme.png.

**Failure scenario.**

An admin reads Appearance, sees the org default is 'System', and believes new users follow their OS; they actually open in Dark (Branding). If the admin then sets Appearance to Light, it silently overrides Branding's Dark for every 'System' user, so the two screens disagree about the same setting.

**Proposed fix.**

Keep one source of truth: remove the Appearance select (or make it a read-only link to Branding > Default theme), or have both controls read/write the same field; at minimum show the effective org default in both places.

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. The report is accurate.

**Skeptic's minimal fix.**

Make Branding `default_theme` the only organization-level theme default.

1. In webui/src/soc/components/CustomizationSection.tsx, remove the "Organization default theme" select and its "Save default" button (around lines 349-368). Remove the `orgTheme` state and the `default_theme: orgTheme` override in `saveOrgDefaults`, and keep spreading `orgFull` so the stored value is round-tripped unchanged.

2. In their place, show a read-only line with the effective value, `effectiveBrandingTheme(useTheme().branding)`, for example "Organization default: Dark. Change it in Branding", linking to Settings > Branding > Default theme.

3. In backend/app/stores/user_prefs.py `resolve_effective_prefs`, stop letting the legacy `CustomizationConfig.default_theme` override Branding. When the user's `theme_mode` is "system", return "system" and let the Console resolve it against Branding. Alternatively, have the backend resolve against `BrandingConfig.effective_theme()` so both paths read the same field.

4. Optionally, on load, if a stored Customization `default_theme` is not "system" and the Branding value is still the factory default, copy it into Branding once, so an existing admin's Light choice is not lost.

### B46. Make primary on a push/queue source reports success but the server silently drops it

- Area: Sources (row menu) and setup wizard
- Severity: medium
- Location: `webui/src/soc/pages/Sources.tsx:367`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Backend only honours primary for pull connectors: is_primary=(body.is_primary and mode == IngestMode.PULL and not reg.is_receiver(st)) (backend/app/api/routes.py:1054). Sources.tsx offers Make primary for every non-primary source regardless of ingest mode (Sources.tsx:941-950) and toasts `${label} is now the primary source` without reading the response (Sources.tsx:358-368). The wizard offers it whenever the connector manifest supports pull even if the source is push (Wizard.tsx:1192-1195; shown on 'Wazuh Manager' push_http in console-c/wizard-1.png). Live API: POST /api/sources with is_primary:true, ingest_mode:'push_http' -> 200 with "is_primary": false.

**Failure scenario.**

An operator makes a webhook or syslog receiver primary, sees the success toast, and assumes chat/log queries now run against it; nothing changed, and the previous primary (or none) still owns the query surface.

**Proposed fix.**

Only offer Make primary for sources whose ingest_mode is pull (same predicate as the backend), and base the toast on the returned is_primary (warn when the server did not set it).

**Skeptic's verdict (first paragraph).**

Confirmed. The backend only honours primary for pull connectors: `is_primary=(body.is_primary and mode == IngestMode.PULL and not reg.is_receiver(st))` at backend/app/api/routes.py:1054. For any other source it sets is_primary=False, leaves the existing primary alone (the `if instance.is_primary:` unset branch never runs) and still answers 200 `{"ok": true}`.

**Skeptic's minimal fix.**

Apply the backend's rule in the UI, and stop toasting success unless the server confirms it.
(1) Sources.tsx:941: render Make primary only when `!s.is_primary && s.ingest_mode === 'pull'`. The server always resolves and stores ingest_mode. A receiver's manifest never lists pull, so this matches `mode == PULL and not is_receiver`.
(2) Sources.tsx setPrimary: read the response, e.g. `const res = await api.upsertSource(...); const ok = res.sources?.some(x => x.id === s.id && x.is_primary);`. Toast success only when ok. Otherwise show a warning such as "Only a pull source can be the primary source".
(3) Wizard.tsx:1192-1195: base canBePrimary on the source's own mode, `source.ingest_mode === 'pull'`. Use the manifest only when ingest_mode is absent. Drop the `manifest?.ingest_modes?.includes('pull')` OR clause that makes a push_http Wazuh source eligible. Also drop the dead `startsWith('pull_')` branch, since IngestMode has no pull_* values.
Add one Vitest per page: a push_http row shows no Make primary item.

### B47. Fresh Demo Mode raises two Critical 'agent health' alarms (precedent corpus starved) on the bell and Effectiveness

- Area: Notifications bell popover, Agent effectiveness, diagnostics in Demo Mode
- Severity: medium
- Location: `backend/app/api/routes_diagnostics.py:1473`
- Owning package: WP15D
- Merged into: B35
- Skeptic verdict: real

**Evidence.**

Immediately after a seeded demo start the bell carries a warning glyph (aria 'agent health needs attention') and lists 'Critical: 0 analyst-confirmed precedents available' and 'Critical: The precedent corpus holds far fewer documents than the case history qualifies' (console-c/bell-popover.png, sweep__effectiveness.png: Analyst-confirmed precedents 0 'Starved'). GET /api/diagnostics/health with demo_active true: precedent_corpus.status 'starved', precedent_documents 0, total_chunks 62 (Runbook 51, MITRE 8, Suppression 3 per Metrics 'Corpus by source'), reconciliation 'qualifying_source_records 33 ... expected 33'. The demo seeds 33 analyst-confirmed cases but never projects them into the demo RAG corpus, and routes_diagnostics.py (1473-1477, 1526-1531) has no Demo handling.

**Failure scenario.**

Anyone opening Demo Mode to evaluate the product is greeted with a warning bell and two Critical 'projection is broken, rebuild the corpus and check the embedding provider' problems that are artefacts of the demo seed, not real faults.

**Proposed fix.**

Project the seeded analyst-confirmed cases into the demo RAG corpus as resolved_case precedents when Demo seeds (both modes), or have the diagnostics mark these checks 'not applicable in Demo' rather than Critical.

**Skeptic's verdict (first paragraph).**

I reproduced it, and the cause is in Demo seeding, not in diagnostics. The diagnostics are reporting a real empty corpus correctly.

**Skeptic's minimal fix.**

In `backend/app/state.py` `_enable_demo_unlocked`, move the `try: await demo_stack.rag_service.ensure_seeded() except ...` block. It currently sits right after the DemoStack is built (about lines 3612-3617). Move it to after every seeded case is saved and the seeded reviews exist: after `_seed_demo_auto_close_reviews(...)` and the capability seeding, and before `run_capability_pass()` and the `mutate_prefs` commit. Fix the misleading comment there too.

The seeded analyst-confirmed CLOSED/RESOLVED cases are then projected as `resolved_case` precedents in both seeded and live mode, without touching `decide()`. In Demo the gateway is the $0 mock. Leave `routes_diagnostics.py` unchanged.

Add a regression test that enables Demo and asserts:
- `precedent_corpus.status == 'ok'`
- `reconciliation.deficit` is false
- no `precedent_corpus_starved` or `precedent_projection_deficit` alert

Optional, so the bell is fully clear in Demo: vary the rule identity of part of the 30-case tuner false-positive block, or record the "one contributor" concentration warning as expected in Demo. Either way, the tuner still needs enough same-rule samples to clear its min-samples bar.

### B48. Demo cost data is incoherent: cases carry AI spend the cost ledger never records, and the simulated rate contradicts the model price

- Area: Cost, Models, Effectiveness in Demo Mode
- Severity: low
- Location: `backend/app/engine/demo_generator.py:1096`
- Owning package: WP15D
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Demo cases get token_cost=round(rng.random()*0.04, 6) with no UsageDoc (demo_generator.py:1096). Summing GET /api/cases: 45 of 77 cases carry $0.7812 (about $0.40 created in the last 7 days), while Cost (Last 7d) shows Total $0.0213, 'LLM calls 1' (one RAG embedding) and Effectiveness says 'AI processing cost / case: No eligible case-associated usage rows'. The one ledger row bills text-embedding-3-small at the fixed demo rate $3/1M (gateway.py:361 _DEMO_IN_RATE; Cost ledger 'Per 1K tokens $0.0030', 7,084 tokens = $0.021252) while Models lists text-embedding-3-small at In $0.0200 per 1M (150x apart).

**Failure scenario.**

A user cross-checking numbers in the demo (the operator's stated goal: hover/click to verify the math) finds case-level AI cost that appears nowhere on the Cost page, and an embedding cost per token that does not match the price on the Models page.

**Proposed fix.**

Seed demo UsageDocs that match each case's token_cost (surface/role/model) or set seeded token_cost to 0; compute the demo synthetic cost from the model's catalog price rather than a fixed Sonnet-like rate.

**Skeptic's verdict (first paragraph).**

Half of this report is a real defect: seeded demo cases show AI spend that the ledger never records. The other half, the embedding rate, is deliberate design. Severity is low.

**Skeptic's minimal fix.**

Pick one of two options in backend/app/engine/demo_generator.py:1096. Either way, keep the rng draw so the seeded story stays deterministic; test_demo_runbooks.py:124 compares token_cost between two runs.

(a) Simplest: draw the value and discard it, then stop showing it as spend. Before the Case(...) call add `rng.random()  # keep the seeded stream stable`, then set `token_cost=0.0`.

(b) Richer: keep the seeded token_cost and have the Demo enable path write the matching ledger row. In state.py, in the seeding loop around lines 3672-3677, write one UsageDoc per seeded case with token_cost > 0 into demo_stack.usage_store. Give it:
- role=investigator
- case_id = the case's id
- timestamp = the case's created_at
- pricing_source='zero'
- cost = the case's token_cost
- prompt_tokens worked out from the cost at the _DEMO_IN_RATE

With either option, the case's figure, the per-case usage summary, the Cost page and Effectiveness all agree.

Also correct docs/getting-started/demo.md:46 and step 6. They should say that demo spend is simulated (synthetic, $0 real), not that it is $0.

Leave the flat synthetic embedding rate unchanged; it is intended.

### B49. Data export 'Build ZIP in background' is enabled in Demo Mode and fails with a raw 409

- Area: Settings > Data export (also Jobs page copy)
- Severity: low
- Location: `webui/src/soc/pages/settings/data-export.tsx`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

In Demo the section offers an enabled 'Build ZIP in background' with 'The server builds and verifies one ZIP before Download appears in Inbox'. Clicking it: POST /api/jobs -> 409 {"detail":"durable jobs are unavailable in Demo Mode"} (routes_jobs.py:713), shown as the raw lowercase toast. data-export.tsx has no demo check, unlike the Audit log export, which docs/administration/audit-log.md:270 says 'says so and stays disabled'.

**Failure scenario.**

A demo user tries the documented export flow and gets an unexplained server error; Jobs and Inbox stay empty.

**Proposed fix.**

Use useDemoGuard in the Data export (and any other Job-submitting control: storage apply, resets) to disable the button with the Demo reason, as the Audit export does.

**Skeptic's verdict (first paragraph).**

I confirmed the defect and reproduced the server side.

**Skeptic's minimal fix.**

In webui/src/soc/pages/settings/data-export.tsx:
1. Read the Demo state with `const { active: demoActive } = useDemo();` from '@/soc/demo' (or use `useDemoGuard()`).
2. Disable the button with `disabled={demoActive || !selected.length || submitting}`, and give it a `title`/`aria-describedby` pointing to a short note: "Data exports are not available in Demo Mode. Turn Demo Mode off to export."
3. Return early from `submitExport` when `demoActive`, so nothing reaches the server.

Apply the same guard to the other Job submitters that lack one: storage.tsx apply, the DangerZone tiered reset and the Knowledge job buttons.

Optional backend hardening: change the generic refusal at routes_jobs.py:713 to a structured `{"code": "jobs_demo_mode", "message": "Background jobs are not available in Demo Mode. Turn Demo Mode off to run this."}`. Any surface that is still unguarded would then show readable text.

### B50. Branding editor shows wrong default accents (violet/teal) while the Console's real defaults are blue/indigo

- Area: Settings > Branding (Accent colours, live preview)
- Severity: low
- Location: `webui/src/soc/components/BrandingEditor.tsx:117`
- Owning package: WP04
- Merged into: none
- Skeptic verdict: real

**Evidence.**

With accent_color and accent_color2 empty (GET /api/branding), the editor fills swatches, the colour inputs, the 1px preview stripe and the Gradient tile from DEFAULT_ACCENT '#6c5ce7' and DEFAULT_ACCENT2 '#00b894' (BrandingEditor.tsx:117-118, 381, 393, 906-907), but an empty accent leaves the stylesheet defaults in force: --primary blue-9 (theme.css:49, 233; '#709df0') and --accent2 indigo (theme.css:137, 288). Screenshot sweep__settings_s_appearance.png: preview bar is blue while 'Primary accent' swatch is violet #6c5ce7. 'Reset to default' also returns to this misleading violet/teal display.

**Failure scenario.**

An admin reads the current accent as #6c5ce7 and the gradient as violet-to-teal, but the Console (and the login gradient driven by --accent2) uses blue and indigo; choosing the 'default' they see changes the Console's colours.

**Proposed fix.**

Derive the placeholder/swatch/gradient from the resolved CSS tokens (--primary, --accent2) of the current theme, or update DEFAULT_ACCENT/DEFAULT_ACCENT2 to the real token values.

**Skeptic's verdict (first paragraph).**

I confirmed this from the code at 3cd362c (the working tree is clean). I didn't run the demo because the code path settles it.

**Skeptic's minimal fix.**

In BrandingEditor.tsx, compute the unset accent fallbacks from the live tokens instead of the hard-coded violet and teal. `resolvedTokenHex` already exists in this file and resolves `var()` and HSL triplets to hex. Inside the component, before the `gradient` line (around line 906):

```ts
const defaultAccent = resolvedTokenHex('--primary') || '#0b5ecb';
const defaultAccent2 = resolvedTokenHex('--accent2') || defaultAccent;
const a1 = accentValid && accent ? accent : defaultAccent;
const a2 = accent2Valid && accent2 ? accent2 : defaultAccent2;
```

Then pass `placeholder={defaultAccent}` and `placeholder={defaultAccent2}` to the two accent ColorFields (lines 1110 and 1118), and delete `DEFAULT_ACCENT` and `DEFAULT_ACCENT2`.

This is safe on reset because `resetAccents` and `onAccent('')` clear the inline overrides before React re-renders, so the render reads the stylesheet defaults for the current theme. Optionally add a BrandingEditor test that, with empty accents, checks the Primary accent swatch is not `#6c5ce7` and that it matches the resolved `--primary`.

### B51. Settings accepts incoherent or unparseable values without validation (SLA respond > resolve, unknown timezone, free-text lookback)

- Area: Settings > SLA, priority & suppression; Data scope
- Severity: low
- Location: `backend/app/config.py:1717`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Saved and confirmed via GET /api/settings (then reverted): P1 response_minutes 600 with resolve_minutes 240 (UI even renders 'Respond within 10 hours, resolve within 4 hours') -> 'Settings saved.'; timezone 'Mars/Olympus' -> 'Settings saved.' (SlaPolicy.timezone is a bare str, config.py:1717; engine/team_activity.py:299 silently falls back to UTC, Team activity reports 'timezone':'UTC'); investigate_lookback 'yesterday' -> saved (config.py:4276), and relative_to_millis resolves unknown text to now() (utils.py:231-242), so the first entity search window is zero-width and the 400 message reads 'in the last yesterday' (routes.py:8342).

**Failure scenario.**

A typo such as 'Asia/Kolkatta' silently moves every calendar window, SLA clock and Team activity day to UTC with no error; an inverted SLA pair produces resolve breaches before response breaches.

**Proposed fix.**

Validate on write (422 with field message): IANA zone via zoneinfo, response_minutes <= resolve_minutes per tier, and investigate_lookback against the now-N[smhdw] grammar used by relative_to_millis_strict; mirror the checks inline in the form.

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not: the defect is real and low severity. I checked it offline with `Preferences.model_validate` on the merged document, which is the only check `PUT /api/settings` makes (backend/app/api/routes.py:2088-2140). The route runs range checks for caps, remember-me and auto-close review and nothing else. Nothing is recorded in docs/releases/known-limitations.md, ROADMAP J or the Round 15 SPEC §8.3.

**Skeptic's minimal fix.**

In backend/app/api/routes.py, add a `_reject_incoherent_settings(body)` beside `_reject_out_of_range_caps`, called in `put_settings._apply` before the merge. It checks only the keys the request body sets and answers 422 with a field-specific message:

(a) `sla.timezone`, when present and non-empty, must be 'UTC'/'Z', a ±HH:MM offset matching `time_windows._OFFSET_RE`, or a name `zoneinfo.ZoneInfo` accepts. Mirror `zone_for`'s grammar rather than requiring strict IANA, because offsets are accepted today.

(b) For each `sla.targets[P]` in the body, merge it with the current target and reject when `response_minutes > resolve_minutes`.

(c) `investigate_lookback`, when present, must give a non-None `relative_to_millis_strict()` that is earlier than now. In practice that is now-N[smhdw] or an ISO time, which rejects 'yesterday' and a zero-width 'now'.

Leave the model loaders and the `zone_for` fallback unchanged, so a config already stored with a bad value still loads. Mirror the three checks as inline field errors in webui/src/soc/pages/settings/case-policy.tsx (SlaTargetRow and the Timezone TextPref) and in settings/general.tsx (Investigate lookback). Add one pytest per rejection and one test that a stored bad config still loads.

### B52. Top bar offers 'Enable updates' on deployments that can never enable one-click updates

- Area: Top bar update control / Settings > Updates & releases
- Severity: low
- Location: `webui/src/soc/components/SystemUpdateControl.tsx:140`
- Owning package: WP05
- Merged into: none
- Skeptic verdict: real

**Evidence.**

bootstrap_required is true whenever the supervisor socket is absent (backend/app/engine/update_service.py:492-498), independent of the other blockers. On this Testing build with a non-PostgreSQL state backend the panel lists 'unavailable from a Testing or source-built deployment' and 'support only PostgreSQL application state', yet the button reads 'Enable updates' (console-c/enable-updates.png). Settings > Updates & releases states 'Custom stacks, unsupported state backends and Testing branch revisions stay manual and show a clear blocker instead of an update action.' The panel footer also says 'Closing this panel does not stop the durable update job.' when no job exists (SystemUpdateControl.tsx:599).

**Failure scenario.**

Every Elasticsearch- or SQLite-backed or source-built deployment shows a permanent call to action that the bootstrap cannot satisfy.

**Proposed fix.**

Show 'Updates unavailable' (or hide the control) when any non-bootstrap blocker (state backend, release channel) is present; compute bootstrap_required only when the supervisor is the sole blocker; show the footer note only while a job exists.

**Skeptic's verdict (first paragraph).**

This is real, but only for non-PostgreSQL state backends. The Testing-channel part of the report is wrong.

**Skeptic's minimal fix.**

In backend/app/engine/update_service.py, change the bootstrap_required expression so a non-PostgreSQL state backend never reports bootstrap as the remedy:

bootstrap_required=(
    state_backend == "postgres"
    and (
        not socket_present
        or not supervisor.available
        or supervisor.protocol_version != SUPERVISOR_PROTOCOL_MIN
        or bool(missing_capabilities)
        or release_identity_blocked
    )
),

The UI then shows 'Updates unavailable' and 'This deployment cannot update itself' without any frontend change. Add a parametrized backend test: with sqlite or elasticsearch and an absent socket, expect bootstrap_required False and postgres_state_required among the blockers. Keep the Testing-channel bootstrap behaviour as it is, because existing tests pin it.

Optional nit: in SystemUpdateControl.tsx, render the footer text 'Closing this panel does not stop the durable update job.' only when `job` is set.

### B53. Notification preferences table is clipped at 1440 px (Telegram column cut off)

- Area: Inbox > Preferences sheet
- Severity: low
- Location: `webui/src/soc/pages/Inbox.tsx`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

In the 672 px sheet the table is 648 px inside a 621 px overflow-x:auto wrapper; the last header 'Telegram' ends at x=1442 on a 1440 viewport and renders as 'Telegra' with toggles half-cut (console-c/inbox-prefs.png). Category descriptions wrap to five lines.

**Failure scenario.**

On a standard desktop the Telegram channel toggles are partly hidden and need an unannounced 27 px horizontal scroll.

**Proposed fix.**

Widen the sheet (sm:max-w-3xl) or shorten channel headers/use icon headers, or move category descriptions to a tooltip so the matrix fits.

**Skeptic's verdict (first paragraph).**

Confirmed from the code and the screenshot. The Inbox Preferences sheet is `<SheetContent side="right" size="lg">` (webui/src/soc/pages/Inbox.tsx:756), and the `lg` size is `w-full max-w-2xl` (webui/src/ui/sheet.tsx:67), so it is always 672 px wide. The body adds `px-6` (Inbox.tsx:763), which leaves about 621 px inside the bordered `overflow-x-auto` wrapper (webui/src/soc/components/NotificationPrefs.tsx:245). The table in that wrapper has 8 columns: Category, In-app, and the six entries of NOTIFICATION_CHANNELS (Email, Slack, Teams, Webhook, PagerDuty, Telegram; webui/src/soc/pages/Inbox.api.ts:170-177). Every channel cell holds a Switch with `px-3` padding (NotificationPrefs.tsx:255-315). With the browser's automatic table layout, the narrowest the table can get is about 648 px, which is more than the wrapper. Every column is therefore squeezed to its narrowest width: "In-app" breaks onto two lines, each category description wraps to four or five lines, and the Telegram column is cut off at the wrapper's edge. The screenshot at <scratchpad>/round16/bugs/console-c/inbox-prefs.png shows exactly this: the header reads "Telegra" and the toggles are half hidden. The only sign that the table scrolls sideways is the scrollbar at the bottom of the 8-row wrapper. That scrollbar sits below the 900 px fold, and with overlay scrollbars it stays invisible until the user scrolls, so the clipped column gives no hint that more content exists. The sheet's maximum width is fixed, so this happens at every desktop width, not only at 1440. This component has only one host (Inbox.tsx:764). The issue is not recorded in docs/releases/known-limitations.md, ROADMAP.md section J or the Round 15 SPEC section 8.3. Severity is low: the toggles can still be reached by scrolling sideways, and nothing is lost or saved wrongly.

**Skeptic's minimal fix.**

In webui/src/soc/pages/Inbox.tsx:756, change the Preferences sheet from `size="lg"` to `size="xl"`, so the line becomes `<SheetContent side="right" size="xl" className="flex flex-col">`. The `xl` size is `max-w-[56rem]` (896 px). That leaves about 845 px for the matrix, well above its 648 px minimum, so all six channel columns fit at desktop widths and the descriptions wrap far less. RuleSheet and SourceLogsSheet already use this size. The `overflow-x-auto` wrapper stays as the fallback for phone widths. Optionally, add `whitespace-nowrap` to the channel and In-app `<th>` classes in NotificationPrefs.tsx:252-259 so that "In-app" stays on one line.

### B54. Help Center says the Stable site does not exist yet, though Stable documentation was published

- Area: Help Center (Other documentation versions)
- Severity: low
- Location: `webui/src/soc/pages/Docs.tsx:616`
- Owning package: WP05
- Merged into: none
- Skeptic verdict: real

**Evidence.**

On a Testing build the panel shows 'Stable site publishes with the first Stable release' instead of the PUBLIC_STABLE_DOCS_URL link (Docs.tsx:603-617). AGENTS.md records that v0.1.12 published 'Stable aliases, and Stable documentation'.

**Failure scenario.**

A Testing operator planning an upgrade is told no Stable documentation exists and gets no link to it.

**Proposed fix.**

Always show the 'Latest Stable' link (labelled as external), or change the copy to say the Stable site describes the Stable release.

**Skeptic's verdict (first paragraph).**

I checked this and the reported defect is real. It is low severity, and the underlying problem is bigger than reported.

**Skeptic's minimal fix.**

1. Point the Stable site URL at the renamed repository: in `webui/src/soc/pages/Docs.tsx:43-44`, set `PUBLIC_STABLE_DOCS_URL = 'https://arydestroyer.github.io/Kavach-AgenticSOC/stable/'`. In `mkdocs.yml`, set the `site_url` default to `https://arydestroyer.github.io/Kavach-AgenticSOC/` and the `stable_docs_url` default to `.../Kavach-AgenticSOC/stable/`. Optionally update the GitHub links too (`DEVELOPMENT_DOCS_URL`, `documentationSourceUrl`, and `repo_url`/`repo_name` in `mkdocs.yml`) to `ARYDESTROYER/Kavach-AgenticSOC`.
2. In `Docs.tsx:603-617`, remove the false sentence. Either always render the "Latest Stable" link (it already opens externally with `rel="noopener noreferrer"`, and the panel already warns that external docs may describe a different version), or keep the channel gate but change the Testing wording to something true, such as "Latest Stable describes the Stable release line" with the link.
3. Update `webui/src/soc/pages/__tests__/Docs.test.tsx:134-135` to match.

### B55. Sessions > Activity shows raw event ids ('User.deleted', 'Auth.login', 'Team.viewed')

- Area: Settings > Sessions & activity
- Severity: low
- Location: `webui/src/soc/pages/Sessions.tsx:408`
- Owning package: WP15A
- Merged into: none
- Skeptic verdict: real

**Evidence.**

activityRows maps action/action_type and the list renders humanizeToken(action) (Sessions.tsx:393, 408). GET /api/account/activity rows carry action 'settings.updated' and no event_label, so the tab shows 'Settings.updated', 'User.created', 'Session.created', 'Decision' (output captured), while the Audit log shows labels such as 'Team activity viewed'.

**Failure scenario.**

Personal activity reads as internal identifiers and differs from the same rows in the Audit log.

**Proposed fix.**

Return event_label from /api/account/activity (the audit route already derives it) and render it, falling back to the humanized action.

**Skeptic's verdict (first paragraph).**

I confirmed this from the code. The working tree is clean, at HEAD 3cd362c.

**Skeptic's minimal fix.**

In backend/app/api/routes.py `account_activity`, label each row the way the audit read API does:

```python
from .audit import events  # or: from ..audit import events, matching the module's package
rows = shown(await _records_for_actor(state, principal.username, limit))
return {"activity": [{**r, "event_label": events.classify(r).label} for r in rows]}
```

In webui:

- Add `event_label?: string` to `ActivityEvent` in webui/src/lib/types.ts.
- In `activityRows`, carry it through as `event_label: text(row.event_label)`.
- In `ActivityList` (Sessions.tsx:408), render `e.event_label || (e.action ? humanizeToken(String(e.action)) : 'Event')`.

Then extend sessions.render.test.tsx to assert that the visible text is 'Signed in', and add a backend test that `/api/account/activity` rows carry `event_label`.

### B56. Team activity person sheet 'Open in Audit log' drops the window

- Area: Team activity > person sheet
- Severity: low
- Location: `webui/src/soc/pages/team/PersonSheet.tsx:219`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The link is pageHash('audit', { actor }) only (PersonSheet.tsx:219). From the Today sheet for farhan.qureshi (2 events) it opens #/audit?actor=farhan.qureshi on 'Last 7 days' with 38 events (console-c/team-to-audit.png).

**Failure scenario.**

A manager checking the rows behind a person's counts sees a different period and many more rows than the sheet counted.

**Proposed fix.**

Pass the sheet's window (from/to) in the audit deep link.

**Skeptic's verdict (first paragraph).**

The defect is real, and its severity is low. I made no changes and the git tree is clean.

**Skeptic's minimal fix.**

Pass the answer's resolved bounds into the sheet and put them on the deep link.

1. webui/src/soc/pages/TeamActivity.tsx, at the `<PersonSheet …>` call (~line 446): add `windowStart={data.window.start}` and `windowEnd={data.window.end}`. Use them only when the shown answer was read for the current window (the existing `fresh` check, `loaded.readFor === windowToken`).

2. PersonSheet.tsx: add `windowStart?: string | null; windowEnd?: string | null` to `PersonSheetProps`, then change line 219 to:
   `href={pageHash('audit', { actor: person.username, ...(windowStart ? { from: windowStart, to: windowEnd ?? undefined } : {}) })}`
   This passes absolute UTC instants, never the `today` / `now-7d` tokens, because Team resolves those to calendar days and the Audit page does not.

3. Update TeamActivity.test.tsx:350 to expect `#/audit?actor=zoe&from=<start>&to=<end>`.

Optional: Team's window is [start, end) while the Audit range end is inclusive. To be exact, pass `to` as end minus 1 ms.

### B57. Permission resource names shown as raw tokens ('Rag', 'Inapp')

- Area: Roles & permissions (Permission check) and Add user grants list
- Severity: low
- Location: `webui/src/soc/pages/Roles.tsx:672`
- Owning package: WP15E
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Resource options are humanizeToken(r) (Roles.tsx:672), giving 'Rag' and 'Inapp' in the Permission check select and in the Add user 'Analyst Tier 1 grants' list (captured dialog text).

**Failure scenario.**

Admins cannot tell that 'Rag' is the knowledge base and 'Inapp' is in-app notifications when granting or checking permissions.

**Proposed fix.**

Map resource ids to display names (Knowledge base, In-app notifications) in one label table shared by Roles and the user dialogs.

**Skeptic's verdict (first paragraph).**

The defect is real, and it shows up in more places than the report names. RESOURCE_ORDER is the list of keys in RESOURCE_ACTIONS (webui/src/soc/pages/Roles.api.ts:134-163), and that list includes the raw ids `rag` (line 141) and `inapp` (line 158). Three places print a resource name with nothing more than humanizeToken(resource):
- the Permission check Resource select (Roles.tsx:672)
- the role matrix editor's row header (RoleMatrixEditor.tsx:244)
- RolePermissionSummary (RolePermissionSummary.tsx:130), which Users.tsx:816 shows in the Add/Edit user dialog.

**Skeptic's minimal fix.**

In webui/src/soc/pages/Roles.api.ts, export a single display-name map for the resource vocabulary and a helper that falls back to humanizeToken for any id without an entry:
`export const RESOURCE_LABELS: Record<string,string> = { rag: 'Knowledge corpus', inapp: 'In-app notifications', data_export: 'Data export', system_updates: 'System updates' };`
`export function resourceLabel(r: string): string { return RESOURCE_LABELS[r] ?? humanizeToken(r); }`
Then replace humanizeToken(r/resource) with resourceLabel(...) at Roles.tsx:672, RoleMatrixEditor.tsx:244 and RolePermissionSummary.tsx:130, which also fixes the Users dialog. Keep the wire ids as the SelectItem values. Add a test that RolePermissionSummary or the Permission check renders "Knowledge corpus" and "In-app notifications" and never "Rag" or "Inapp".

### B58. SLA response clock never stops for agent auto-closed cases, so SLA attainment falls over time with no change to any case

- Area: data-correctness / SLA (posture, Metrics Posture tab, SOC operations and Executive boards)
- Severity: high
- Location: `backend/app/engine/metrics.py:951`
- Owning package: WP15C
- Merged into: B26
- Skeptic verdict: real

**Evidence.**

In sla_metrics, resp_at = timings.resp_anchor or timings.resp_human (line 947). resp_human only counts status moves made by a person, so an agent auto-close (by='agent') leaves resp_at None. The 'still unresponded → live clock' branch (line 951) then measures now − created even though the case is terminal. Live seeded demo: every breach the 7d posture lists for CASE-000022, 24, 25, 31, 32 and 34 reads 'Response target, P4, Nd over'. Each of those cases was auto-closed FALSE_POSITIVE by the agent at creation (status_history [('closed','agent',created)]). Screenshot: posture-sla-autoclosed-breached.png. The same case's header in Case Manager reads 'Auto-closed as false positive' (case22-header-sla-closed.png). In caseFacts.slaReading a terminal case is 'SLA closed' (met). Formula: attainment = (evaluated − distinct breached case ids) / evaluated. Live values: 24h 97.4% (only breach is CASE-000040, auto-closed), 7d 76.8% (91.1% with response clocks stopped at close), 30d 67.5% on the Executive board (87.0% with clocks stopped). I re-ran the real sla_metrics on the same 38 cases from the 24h window with now+9h: attainment goes from 97.4% to 5.3% and resp_breached from 1 to 36. Related: the response clock also ignores acknowledged_at. It reads first_response_at, which nothing writes (ROADMAP J), and human status moves. CASE-000043 was acknowledged at 22.6 min while already 'investigating' (system), so no status move was recorded. MTTA counts it (posture mtta count went 2 to 3) and the case header switches to 'Resolution due in 24h', yet sla_metrics flags a response breach at +3h (simulated).

**Failure scenario.**

An operator opens the Executive summary or Metrics Posture on a deployment where autopilot closes most alerts. SLA attainment keeps falling every hour after each automatic close crosses its P-level response target (P4: 480 min) and approaches 0%. The breach list fills with cases the agent closed in seconds. An analyst who acknowledges an already-investigating case still breaches.

**Proposed fix.**

In sla_metrics, stop the response clock at the first terminal transition. Either count a terminal agent close as response-met (or not applicable) or end elapsed at timings.terminal_any. Use acknowledged_at (ack_anchor) as a response anchor, as MTTA and webui caseFacts.slaReading already do. Add tests: an auto-closed case at now+N h is never breached, and an acknowledge without a status change stops the clock.

**Skeptic's verdict (first paragraph).**

I reproduced the defect with the real function at HEAD. The tree is clean.

**Skeptic's minimal fix.**

Change the response clock in `sla_metrics` (backend/app/engine/metrics.py, around lines 946-947):

```python
status_now = c.status.value if c.status else ""
resp_at = timings.resp_anchor or timings.ack_anchor or timings.resp_human
if resp_at is None and status_now in _TERMINAL:
    # A terminal case can no longer be "awaiting response". This includes an
    # agent or analyst-policy auto-close, which has no human move. Stop the
    # clock at the terminal instant, so an auto-close made after the target
    # still counts as late.
    resp_at = timings.terminal_any or timings.updated_iso
```

Leave the rest of the response block as it is. With `resp_at` set, it takes the "responded, but late" branch and is breached only if `(resp_at - start)` is over the target.

Keep the audit #9 rule: a system or agent move into a non-terminal status (for example auto-escalation at creation) still does not stop the clock.

Add tests in backend/tests:
1. An agent auto-closed CLOSED case at created+9h and created+48h is never response-breached or at_risk, and attainment is 100%.
2. An INVESTIGATING case moved there by system, with `acknowledged_at` = created+22 min, is not breached at created+9h.
3. An ESCALATED case moved there by system at creation, with no acknowledgement, still breaches after the target.
4. A case auto-closed after its response target counts as a late response.

### B59. Metrics > Operational MTTR uses updated_at − created_at over 'closed' only, so any later edit inflates it (10m to 6h 41m after one comment)

- Area: data-correctness / Analytics Metrics Operational tab (GET /api/metrics)
- Severity: high
- Location: `backend/app/engine/metrics.py:356`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

compute_metrics 'Coarse MTTR' (lines 356-362) averages (updated_at − created_at) over cases with status == CLOSED. The same function's burndown uses _first_transition_at, and posture uses the first terminal transition. Metrics.tsx:602 renders it as 'MTTR … N closed, all time'. Reproduction on the live seeded demo: GET /api/metrics → mttr_minutes 10.2, resolved_count 51. POST /api/cases/demo-00000539-0041/comment {"body":"late note"} on CASE-000001 (closed 2026-11-11T00:07; the comment route sets case.updated_at = iso_now(), routes.py:8086). GET /api/metrics → mttr_minutes 401.3 and the tile reads 6h 41m. Posture all-time MTTR is unchanged (mean 33.5 over 62). Screenshots: metrics-mttr-10m-before-comment-crop.png and metrics-mttr-6h41m-after-one-comment-crop.png. Even before the edit the tile left out the 11 'resolved' cases. The tile beside it says 'Resolved or closed 62', and the all-time posture mean is 33.5 min over 62 cases against this tile's 10.2 min over 51.

**Failure scenario.**

An analyst comments on, tags, assigns, grades, reviews or attaches a screenshot to an old closed case. The headline MTTR on Analytics jumps by hours and stays wrong, and it disagrees with the Performance tab and posture MTTR for the same population.

**Proposed fix.**

Compute the legacy mttr_minutes from _resolved_dt (first terminal transition) over terminal cases (closed and resolved), or point the Operational tile at posture lifecycle.mttr_minutes (all-time). Label the statistic (mean or p50).

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. The defect is real.

**Skeptic's minimal fix.**

In backend/app/engine/metrics.py compute_metrics, replace the 'Coarse MTTR' loop. Use the same clock as posture: the first terminal transition, over every terminal case (resolved and closed).

    resolution_minutes: list[float] = []
    for c in cases:
        end = _resolved_dt(c)  # first RESOLVED/CLOSED transition; None for a reopened case; falls back to updated_at only with no recorded transition
        start = _parse_iso(c.created_at)
        if start and end and end >= start:
            resolution_minutes.append((end - start).total_seconds() / 60.0)

Keep mttr as the rounded mean and resolved_count = len(resolution_minutes); the wire shape is unchanged. Update the comment to say 'first terminal transition', not 'updated_at'.

In webui/src/soc/pages/Metrics.tsx:602-604, make the copy match:
- context: `${fmtNumber(data.resolved_count)} resolved or closed, ${population}`
- help: 'Mean time from a case's creation to when it was first resolved or closed. Later edits do not change it.'

Add one regression test. Set a CLOSED case's status_history closed_at to T+10m, then bump updated_at by days: mttr_minutes must stay 10.0. A RESOLVED case must be counted in resolved_count.

### B60. Standup and SOC operations 'SLA breached' use the unpersisted priority_level (always 120-min default, 'unprioritized') and ignore acknowledgement

- Area: data-correctness / Standup, SOC operations board (GET /api/standup/report sla_aging)
- Severity: medium
- Location: `backend/app/engine/shift_report.py:272`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

sla_aging buckets by getattr(case,'priority_level') or 'unprioritized' (line 272). It picks the target through _response_target_minutes (lines 98-105), which reads the stored priority_level. metrics._sla_priority (metrics.py:881-894) documents that 'no production path persists the level' and projects it with advisory_bands; shift_report does not. It also compares age (now − created) with the response target, whatever the acknowledgement. Live GET /api/standup/report: sla_aging.by_priority = {"unprioritized": {open 15, breached 10}}, and every breached row has priority_level "" and target_minutes 120. GET /api/cases shows the same cases as P3 or P4. Simulation with the real function: CASE-000045 (projected P4, posture target 480 min, stored priority '') is Standup-breached at +3h with target 120, while posture sla_metrics reports no breach.

**Failure scenario.**

P4 cases (480-min target) show as breached on Standup and the SOC operations 'SLA breached N of M open' tile after 2 h, while Metrics Posture says they are within target. Cases acknowledged long ago keep counting as breached once they are older than the target.

**Proposed fix.**

Resolve the P-level with the same projection as metrics._sla_priority (pass prefs), and stop the response clock at acknowledged_at or the first human response. Better: have shift_report reuse sla_metrics for open cases, so the two surfaces cannot drift.

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. It is a real defect and is not recorded anywhere.

**Skeptic's minimal fix.**

In `backend/app/engine/shift_report.py`:

1. Give `sla_aging(cases, sla, *, now=None, warn_fraction=0.75, prefs=None)` a `prefs` argument. Resolve the level with the same projection Posture uses: `prio = metrics._sla_priority(case, prefs)`, which takes the stored level if set and otherwise `advisory_bands(case, prefs)["priority_level"]`. Bucket by that level, still falling back to "unprioritized", and look the target up by it. Do this through a `_response_target_minutes(case, sla, prio)` overload, and have `urgency_score` resolve the level the same way.
2. Stop the response clock once someone has responded. Build `metrics._CaseTimings(case)` and set `resp_at = timings.resp_anchor or timings.resp_human`, treating `acknowledged_at` and `ack_human` as a response too if acknowledgement should count. If `resp_at` is set, count the case as breached only if it responded late, that is `(resp_at - start) > target`. Otherwise keep the live clock. If the board's "response or resolve" wording is meant literally, also check the resolve target, as `sla_metrics` does.
3. Pass `prefs` through: `build_shift_report` → `headline_counts(..., prefs=prefs)` → `sla_aging(..., prefs=prefs)` and the direct `sla_aging` call. Also pass it from `chat_starters.py:1381` and `:1496` (`prefs=b.prefs`).
4. Add a regression test for each failure: a P4-projected case with no stored level at 3 hours is not breached, and a case acknowledged at 10 minutes is not response-breached at 3 hours, both matching `metrics.sla_metrics(prefs=...)`.

### B61. Demo seed: analyst closes carry no classification entry, so 17 human true-positive closes read 'Outcome not recorded' and Executive 'Confirmed threats' shows 1

- Area: data-correctness / demo data (Cases, Overview Latest cases, Executive summary, Team activity)
- Severity: medium
- Location: `backend/app/engine/demo_generator.py:863`
- Owning package: WP15D
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_with_seeded_decision (lines 863-923) rewrites status_history so a person acknowledges and closes or resolves the case. It never appends the analyst_action history entry with classified_disposition that a real close writes (routes.py:7738-7746). caseOutcome (webui outcome.ts) and the backend authority need that entry. Live: all 17 terminal decision_by=analyst cases (disposition true_positive, status reason 'demo: SQL injection …, true positive') have history ['decision'] only. Cases and Overview show 'Not recorded / closed by analyst: outcome not recorded' for CASE-000001, 42 and the rest. GET /api/metrics/breakdown?by=severity&window=now-720h gives analyst_tp 0 for critical (13) and high (18), and 1 for medium. The Executive 'Confirmed threats 1' is CASE-000038, an auto-close review disagreement. The same closes are recorded elsewhere: the audit row 'meera.pillai case.closed … disposition=true_po…' and Team activity meera.closed_by.true_positive = 1.

**Failure scenario.**

A demo viewer sees 18 true-positive dispositions in the Disposition mix and 17 analyst TP closes in the audit log and Team activity, yet the Executive summary says 1 confirmed threat and every human-closed case says the outcome was not recorded.

**Proposed fix.**

In _with_seeded_decision, append the analyst_action entry (action close or resolve, classified_disposition = case.disposition, analyst, ts = closed) that _perform_case_action writes. Optionally add structured changes to the seeded audit rows.

**Skeptic's verdict (first paragraph).**

Confirmed against the code and reproduced offline. Nothing in the repository was changed, and `git status --short` is empty.

**Skeptic's minimal fix.**

In `backend/app/engine/demo_generator.py` `_with_seeded_decision`, after `status_history` is rewritten for an analyst-closed case (just before `case.acknowledged_at = ...`), append the history entry that the live `_perform_case_action` writes for a declared close or resolve:

```python
disposition = getattr(case.disposition, "value", case.disposition)
entry = {"ts": closed, "event": "analyst_action",
         "action": "close" if status == CaseStatus.CLOSED.value else "resolve",
         "analyst": person, "note": ""}
if disposition:
    entry[CLASSIFIED_DISPOSITION_KEY] = str(disposition)  # from .analyst_outcomes
case.history.append(entry)
```

For consistency, also add `AuditChange(field="classified_disposition", after=disposition)` to the seeded close and resolve audit rows in `demo_team_activity_audit_rows`; today only `verb == "close"` adds the `disposition` change. Add a regression test: every terminal decision_by=analyst case the seed builds gives a non-None `analyst_confirmed_outcome`, and the seeded audit row's disposition matches it.

### B62. Demo risk factors do not reproduce from the case's own inputs (same Volume 72 for 3 and 6 alerts; asset criticality 47 while the impact chip says 0)

- Area: data-correctness / risk explanation ('How 62/100 was derived', /api/cases/{id}/triage and /stages)
- Severity: medium
- Location: `backend/app/engine/demo_generator.py:926`
- Owning package: WP15D (Demo hunk of B13)
- Merged into: B13
- Skeptic verdict: real

**Evidence.**

_demo_risk_breakdown derives the five factors from the total only, so they reconcile to the score but not to the inputs. The engine formula is volume = 100·log1p(n)/log1p(50) (risk.py:24-27, 80) and diversity = 100·rules/5. CASE-000046 (3 alerts, 1 rule) and CASE-000043 (6 alerts, 1 rule) both show Volume 72/100 and Diversity 52/100. The formula gives Volume 35.3 and 49.5 and Diversity 20. Screenshot case46-risk-factors.png: '6 alerts clustered into one case' next to 'Volume 72/100'. The same /api/cases/demo-hitl-00000539-0000/triage response returns risk.breakdown.asset_criticality 47 and impact {value 0, criticality 0}, although priority.impact_band's docstring says both read the same _asset_criticality. Reputation 67 on a user-entity case whose definition says '0 if no IP'.

**Failure scenario.**

The user asked to cross-verify a risk score from its exact numbers. In the demo, any attempt to re-derive a factor from the event count, rule count or asset map fails, and the risk breakdown contradicts the impact chip on the same page.

**Proposed fix.**

Generate the demo breakdown with compute_risk from a synthetic cluster that matches the case (member_event_ids count, window, rule count, entity), plus a seeded reputation only when the cluster carries an IP. Then set the case's risk_score from that breakdown, or seed asset_criticality and asset_networks prefs that match.

**Skeptic's verdict (first paragraph).**

The defect is real. I reproduced it offline and the working tree is clean afterwards.

**Skeptic's minimal fix.**

In demo_generator.py, replace the total-only `_demo_risk_breakdown(risk)` with a breakdown built from each case's own inputs.

1. Build a synthetic `Cluster` that matches the case:
   - `entity` = the case's entity
   - `rule_values` = `rule_ids`
   - `count` = `len(member_event_ids)`
   - `first_seen_millis` and `last_seen_millis` from a window drawn from the case's own seeded Random, so the main seed stream is unchanged
2. Run `compute_risk(cluster, demo_prefs, reputation)`, where `reputation` is a seeded value only when `entity.type == IP` and 0 otherwise. Use the demo prefs (empty asset map, so asset is 0 and matches the impact chip), or add matching `asset_criticality` entries for the demo hosts and users to the demo prefs.
3. Set `case.risk_score = breakdown.total`. For IP cases you may instead solve reputation (clamped to 0..100) as the residual toward the template's target risk.

Apply this at all three call sites: lines 1074, 1281 and 1320. Then extend test_demo_mode.py so it also checks that:
- volume and diversity equal the engine formulas for `len(member_event_ids)` and `len(rule_ids)`
- velocity is 0 below 3 events
- reputation is 0 for user and host entities
- asset_criticality equals `derive_triage(case, prefs)['impact']['value']`

### B63. Timeline 'Decision' stage takes its time from updated_at and re-derives the decision from today's policy instead of the recorded decision

- Area: data-correctness / Case Manager Overview timeline (/api/cases/{id}/stages, trace)
- Severity: medium
- Location: `backend/app/api/routes_triage.py:419`
- Owning package: WP10
- Merged into: none
- Skeptic verdict: real

**Evidence.**

_decision_span (lines 393-430) calls decide() with the current state.prefs and sets ts=case.updated_at. Live: CASE-000043's decision event is at 20:24:04 (history[0]). After I acknowledged it, GET /stages showed decide ts 2026-11-24T20:46:38.862583 (the acknowledge time) and the Console timeline printed 'Decision 20:46:38 UTC'. Offline with the real function on CASE-000048 (status closed, decision_by agent, recorded rationale 'FALSE_POSITIVE auto-closed: confidence 0.97 >= 0.85 …'): with default prefs the stage reads 'Auto-closed by policy'. With auto_close.false_positive.min_confidence = 0.99 it reads 'Held for human review | FALSE_POSITIVE routed to human: did not clear the auto-close bar (confidence 0.97 vs 0.99 …)'.

**Failure scenario.**

Any comment, acknowledgement, tag or review moves the case's 'Decision' to a later time. After an operator tightens the auto-close policy, every historical auto-closed case's timeline claims the AI held it for a human, which contradicts its status, its decision_by and its own recorded history.

**Proposed fix.**

Read the decision stage from the case's history entry with event=='decision' (its ts, status, decision_by and rationale). Re-derive with decide() only as a fallback for legacy cases without that entry, and label it as evaluated under the current policy.

**Skeptic's verdict (first paragraph).**

I could not refute it. I reproduced the defect offline with the real functions (script at <scratchpad>/repro_decide.py). The repository is unchanged; `git status` is clean.

**Skeptic's minimal fix.**

In `_decision_span` (`backend/app/api/routes_triage.py`):

1. Look up the last entry in `case.history` that is a dict with `event == "decision"`. Take the last one, because re-investigation appends a new entry.
2. If that entry exists, build the span from it:
   - `ts` from `entry["ts"]`
   - `summary` from `entry["rationale"]`
   - `payload_ref.decision_status` from `entry["status"]`
   - `payload_ref.decision_by` from `entry["decision_by"]`
   - `payload_ref.escalate` from `entry["escalate"]`
   - `payload_ref.objection_window_expires_at` from the stored `case.objection_window_expires_at`
   - `deterministic: True` and `source: "recorded"`
3. Call `decide()` only when no such entry exists (legacy cases). In that branch, keep `ts` as None rather than `updated_at`, and mark the payload `source: "rederived_current_policy"` so the UI can label it as evaluated under the current policy.
4. Keep `policy_clause` as the current-config display, and label it "current policy" in the payload. Nothing else needs to change: `_build_stages` and the DecisionCard already read `dspan.ts`, `dspan.summary` and `payload_ref`.
5. Add a regression test: auto-close a case, bump `updated_at`, tighten `min_confidence`, then assert that the decide stage keeps the recorded ts, the "Auto-closed by policy" headline and the recorded rationale.

### B64. Overview noise flow prints 'Cases opened 56 · 147%' of clusters when the alert counters cover only part of the window

- Area: data-correctness / Overview Noise reduction flow (Simple view)
- Severity: medium
- Location: `webui/src/soc/components/NoiseFunnel.tsx:363`
- Owning package: WP12
- Merged into: none
- Skeptic verdict: real

**Evidence.**

stageShare (lines 363-394) divides each stage by its parent's total, whatever counters.incomplete says. The rail (line ~2006) and the graph use it. Live Overview at Last 7d: GET /api/metrics/noise-reduction?window_hours=168 → clustered 38 (counters since 20:30:09, incomplete: true) and cases 56 (7 days of cases). The flow shows 'After clustering 38 clusters · 23%' then 'Cases opened · 56 · 147%' and draws 38 clusters fanning out into 56 cases. Screenshot overview-7d-noise-flow-147pct.png (DOM: <span data-stage-share="cases">· 147%</span>). The Detection and data health board handles the same data correctly ('Alerts per case not measured: partial coverage').

**Failure scenario.**

On any install younger than the selected window, or after a counter gap, the Overview reports more cases than clusters and a share above 100%.

**Proposed fix.**

When data.counters.incomplete is true, give stages whose parent is a counter stage (clustered → cases) the em dash with 'not measured: partial coverage', as the board does. Never print a share above 100% for a reduction stage.

**Skeptic's verdict (first paragraph).**

I reproduced it, and it is not recorded anywhere. I found nothing about it in docs/releases/known-limitations.md, ROADMAP.md (backlog) or Round 15 SPEC §8.3.

**Skeptic's minimal fix.**

In NoiseFunnel.tsx, route all four Simple-view `stageShare` call sites (:2006, :2663, :2746, :3072/:3097) through one small wrapper that knows the payload, or give `stageShare` an extra options argument.

Return `{pct: null, text: SHARE_DASH, sentence: 'not measured: partial coverage'}` in either of these cases:
(a) the stage's parent is a counter stage while the stage itself comes from the case tally (`cases`, and `candidate`/`awaiting` if they are case-sourced, all with parent `clustered`), and `data.counters?.incomplete === true`. Reuse PARTIAL_COVERAGE_NOTE from dashboard/widgets/detection.tsx so the flow and the board say the same thing.
(b) `total > denominator` for any reduction stage. Use em dash plus a reason such as 'more cases than clusters counted in this window', following MORE_CASES_THAN_ALERTS, so a share above 100% is never printed.

Keep the `clustered`-of-`ingested` share as it is, since both come from the counters. Add a regression test: incomplete counters with cases > clustered must give `data-stage-share="cases"` text `·` followed by the dash placeholder.

### B65. Demo precedent corpus is seeded before the demo cases exist, so every page shows a false 'Agent health needs attention' banner

- Area: data-correctness / Demo diagnostics (Effectiveness Agent health, global banner)
- Severity: medium
- Location: `backend/app/state.py:3615`
- Owning package: WP15D
- Merged into: B35
- Skeptic verdict: real

**Evidence.**

Demo enable calls demo_stack.rag_service.ensure_seeded() at line 3615 (comment: 'picks up any CLOSED demo cases too'), then generates the historical cases at line 3622. ensure_seeded is idempotent and runs nothing later. Live GET /api/diagnostics/health?window_hours=168: precedent_documents 0 and status 'starved', reconciliation.deficit true, 'the corpus holds 0 analyst-confirmed precedent document(s) but the case history qualifies 33 record(s)', and ground_truth.analyst_confirmed_cases 33. Every captured page ends with 'Agent health needs attention: 0 analyst-confirmed precedents available; The precedent corpus holds far fewer documents than the case history qualifies'. Effectiveness shows '2 problems detected'.

**Failure scenario.**

Every fresh seeded or live demo presents a broken-projection alarm on all pages, which tells evaluators the agent's institutional memory is broken when it is only a seeding-order artefact.

**Proposed fix.**

Seed or refresh the demo RAG corpus after the historical, recent and capability cases are saved, for example by calling a reseed or repair_precedent_projection after number_seeded_cases. Alternatively, keep ensure_seeded where it is and run a precedent refresh at the end of demo enable.

**Skeptic's verdict (first paragraph).**

I reproduced the defect and the report is accurate.

**Skeptic's minimal fix.**

In backend/app/state.py `_enable_demo_unlocked`, move the eager `await demo_stack.rag_service.ensure_seeded()` block (currently at about line 3613, inside its existing try/except) down to just after the last seeded-case save. That point is after the capability-seeding block, which saves the hitl and tuner cases and runs `seed_hitl_proposals`, and before the commit with `mutate_prefs`. The first and only seed of this fresh stack then projects the 33 analyst-confirmed seeded cases. If the early seed must stay so the Knowledge page fills sooner, keep it and add `await demo_stack.rag_service.rebuild_corpus()` at that later point, inside a never-blocks-enable try/except. Add a regression test: after `enable_demo(mode='seeded')`, `/api/diagnostics/health` reports `precedent_corpus.status == 'ok'`, `documents_by_source['resolved_case'] == ground_truth.analyst_confirmed_cases`, and no `precedent_corpus_starved` or `precedent_projection_deficit` alert.

### B66. Overview 'Respond' copy says assignment counts and calls the p50 a mean, but the clock ignores assignment

- Area: data-correctness / Overview Response time
- Severity: low
- Location: `webui/src/soc/pages/Overview.tsx:4768`
- Owning package: WP12
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The sub-line reads 'First human action, e.g. assignment or acknowledgement · same clock as MTTA'. The help text reads 'Mean time to respond: the first active human response (investigating / escalated / assignment / ack)'. The value is posture lifecycle.mtta_minutes.p50 (the tile itself says 'p50 · 2 samples'). MTTA counts acknowledged_at or human moves to investigating, escalated or on_hold (metrics.py _ACK_STATUSES), and assignment never sets acknowledged_at (only action=='acknowledge' does, routes.py:7614-7615). Reproduction: POST /api/cases/demo-recent-00000539-0002/assign {"assignee":"Admin"} on unacknowledged CASE-000045, and posture 24h mtta_minutes.count stays at 2.

**Failure scenario.**

An analyst assumes assigning a case stops the Respond and MTTA clock, and reads a median as a mean.

**Proposed fix.**

Change the copy to 'First human acknowledgement (or a move to investigating, escalated or on hold) · p50 · same clock as MTTA'. Alternatively, make a first assignment an acknowledgement in the backend and document it.

**Skeptic's verdict (first paragraph).**

I reproduced this defect. It is not covered by any known-limitation record.

**Skeptic's minimal fix.**

Fix the copy, not the backend. In webui/src/soc/pages/Overview.tsx:

1. Line 4768, Respond sub-line: "First human acknowledgement, or a move to investigating, escalated or on hold · same clock as MTTA".
2. Line 4770, Respond help: "Median (p50) time to respond: case open → the first human acknowledgement, or a human move to investigating, escalated or on hold. Assigning a case alone does not stop this clock."
3. Line 4749, MTTD help: change "Mean time to detect" to "Median (p50) time to detect" so it matches the value shown.
4. Update the regex in webui/src/soc/__tests__/overview.inventory.test.tsx:477 to match the new sub-line.
5. Optionally, change "assigning/" in ROADMAP.md:712, since it repeats the same wrong claim.

If the product wants assignment to count, the alternative is a deliberate backend change: stamp `acknowledged_at` on a first non-empty assignment in `case_assign` (routes.py:8142). That needs a test and a docs note. The copy fix is the smaller correct change.

### B67. Overview Latest cases labels status 'closed' as 'Resolved'

- Area: data-correctness / Overview Latest cases
- Severity: low
- Location: `webui/src/soc/pages/Overview.tsx:1010`
- Owning package: WP12
- Merged into: none
- Skeptic verdict: real

**Evidence.**

latestCaseStatus maps both 'closed' and 'resolved' to { label: 'Resolved' }. Live: CASE-000042 and CASE-000048 have status 'closed' (GET /api/cases). Overview Latest cases shows 'Resolved', while Cases and Case Manager show 'Closed' for the same rows. CaseStatus keeps resolved and closed as distinct lifecycle states.

**Failure scenario.**

An operator sees a case as Resolved (pending final close) on the Overview and Closed in Cases, two different lifecycle claims for one record.

**Proposed fix.**

Map 'closed' to 'Closed' and 'resolved' to 'Resolved' (both success variant), matching statusWords and the queue.

**Skeptic's verdict (first paragraph).**

I could not refute it. The defect is real and low severity.

**Skeptic's minimal fix.**

In webui/src/soc/pages/Overview.tsx, function `latestCaseStatus`, replace line 1010 with two branches:
  if (key === 'closed') return { label: 'Closed', variant: 'success' };
  if (key === 'resolved') return { label: 'Resolved', variant: 'success' };
Then update webui/src/soc/__tests__/overview.inventory.test.tsx: the CASE-1003 fixture has status 'closed', so line 491 should expect `getByText('Closed')` and line 975 should expect `within(fpRow).getByText('Closed')`. Optionally add a test where a 'resolved' row still reads "Resolved". If it is fixed in the same pass, the sibling 'needs_human' branch should use the shared `statusLabel` wording, "Open · awaiting analyst", instead of "Escalated".

### B68. Top detection rules 'N more rules' counts rules with zero cases in the window

- Area: data-correctness / Detection and data health board (GET /api/metrics/breakdown by=rule)
- Severity: low
- Location: `backend/app/engine/case_aggregate.py:1161`
- Owning package: WP15C
- Merged into: none
- Skeptic verdict: real

**Evidence.**

When open_now is requested, every group that only has open cases from any arrival date is added with count 0 (count_by.setdefault(gkey, 0), line 1161) and ranked and trimmed into 'other'. Live: other = {count: 10, groups: 14}, and the board says '14 more rules account for 10 more case rows'. Raw recount of the 56 cases in the 7d window: 20 distinct rules, 10 shown, so 10 more rules with cases. The extra 4 (IMPOSSIBLE-TRAVEL, 100126, 'LP QRadar: anomalous bulk data staging', 'Entra ID Protection: anomalous bulk-access sign-in') have 0 cases in the window and only older open cases.

**Failure scenario.**

The caption overstates how many rules fired in the window. On a quiet window, a rule with 0 window cases can also take a Top-10 slot.

**Proposed fix.**

Exclude zero-count groups from 'other.groups' and from the top-N ranking (keep open_now only as a column), or word the caption so it counts open-only rules separately.

**Skeptic's verdict (first paragraph).**

I tried to refute this and couldn't. The defect is real and low severity. I reproduced it at the engine level and read the code path; I did not re-run the live demo.

**Skeptic's minimal fix.**

In backend/app/engine/case_aggregate.py `build_case_result`, inside the `if trimmed:` branch, also report how many trimmed groups have a count in the window. Add `"groups_counted": sum(1 for g in trimmed if count_by.get(g, 0) > 0)` to the `other` dict, and keep `"groups": len(trimmed)` so chat's `_other_groups` still covers the open-now part of its Other row.

Then in backend/app/api/routes_metrics.py:1410, build `MetricsBreakdownOther` with `groups=int(result.other.get("groups_counted", result.other.get("groups")) or 0)`. The dashboard's "N more rules account for M more case rows" and "Other (N more)" then count only groups that hold some of M.

Add a regression test to backend/tests/test_metrics_breakdown.py. Seed a rule whose only case is an open case older than the window, request `by=rule&window=now-7d&top=1`, and assert that `other.groups` equals the number of trimmed rules with a window count.

### B69. Demo per-case 'Investigation cost' has no ledger rows behind it

- Area: data-correctness / Case facts rail vs Cost ledger (non-negotiable #6 roll-up)
- Severity: low
- Location: `backend/app/engine/demo_generator.py:1096`
- Owning package: WP15D
- Merged into: B48
- Skeptic verdict: real

**Evidence.**

_hist_case sets token_cost=round(rng.random()*0.04, 6). Live: the case token_cost values sum to $0.7812 across 77 cases and $0.3835 across 7d cases. GET /api/usage/summary?window_hours=720 shows 1 call ($0.021252, embedding, surface rag) and no investigation calls. Effectiveness says 'AI processing cost / case - No eligible case-associated usage rows'. FactsRail.tsx:466 renders 'Investigation cost $0.0xx' for these cases.

**Failure scenario.**

A demo viewer adds up case costs and finds them 37× the Cost page total, and Effectiveness says no case has any recorded cost.

**Proposed fix.**

Seed token_cost = 0 for demo history (consistent with the $0 mock and no ledger rows), or seed matching UsageDoc rows in the demo usage store with the same case_id.

**Skeptic's verdict (first paragraph).**

I reproduced the defect. It is real and low severity, and it only affects Demo Mode.

**Skeptic's minimal fix.**

In `backend/app/engine/demo_generator.py`, `_hist_case`, keep the random draw so the seeded stream stays the same, but stop using it as a cost. Seeded history never ran through the gateway and has no ledger rows. For example, put `rng.random()  # keep the seed stream; seeded history has no ledger rows` before the `Case(...)` call, then set `token_cost=0.0` instead of `round(rng.random() * 0.04, 6)`. That leaves every other seeded field byte-identical. The `test_demo_runbooks.py:124` determinism tuple still passes because it compares two runs against each other.

Alternative: if Demo should show per-case cost, seed one demo-surface UsageDoc per seeded case into `demo_stack.usage_store` with role investigator, `case_id`, `pricing_source='zero'`, the same cost and a timestamp at the case's `created_at`. The case cost and the ledger would then reconcile as they do for live Demo investigations.

Add a regression test: after `enable_demo`, each seeded case's `token_cost` equals `usage_store.total_pipeline_cost_for_case(case_id)`, or 0 for cases with no ledger rows.

### B70. Case rationale, trace and export routes skip the cases:read check (outside the data-correctness area)

- Area: authorization (RBAC on with custom roles or deny maps)
- Severity: low
- Location: `backend/app/api/routes.py:8517`
- Owning package: WP15A
- Merged into: B01
- Skeptic verdict: real

**Evidence.**

GET /cases/{case_id}/rationale (8517), /trace (8498) and /export (8191) declare no require_permission and call no _enforce. Siblings /cases/{case_id}, /threat-context and /forwarding do. The router only adds require_auth (main.py:154). /export returns the full case.model_dump. All six built-in roles grant cases:read (rbac/policy.py DEFAULT_MATRIX), so only a custom role or deny map without cases:read is exposed. Not exercised live.

**Failure scenario.**

With role-based access on, a user whose custom role denies cases:read can still export any case as JSON and read its rationale and trace (prompt excerpts when trace.include_prompts is on).

**Proposed fix.**

Add _=Depends(require_permission('cases','read')) to the three routes, plus the object-scope check that GET /cases/{id} uses.

**Skeptic's verdict (first paragraph).**

Confirmed by reading the code and reproducing it offline. backend/app/api/routes.py:8191 (case_export), 8498 (case_trace) and 8517 (case_rationale) declare no require_permission and make no in-body _enforce or has_permission call. Their router gets only require_auth (main.py:154), and require_auth checks authentication only (deps.py:92). The sibling routes do declare require_permission("cases","read"): GET /cases/{id} at 7150, /threat-context at 8439, /forwarding at 8534. test_route_auth_coverage.py checks authorization only on non-GET routes, so CI does not catch this. None of the three is recorded in known-limitations.md, ROADMAP section J or the Round 15 SPEC section 8.3.

**Skeptic's minimal fix.**

Add `_=Depends(require_permission("cases", "read"))` to these six GET routes:
- `case_export` (backend/app/api/routes.py:8191)
- `case_trace` (8498)
- `case_rationale` (8517)
- `get_case_activity` (backend/app/api/routes_cases_collab.py:411)
- `get_case_thread` (461)
- `get_case_tasks` (708)

On `case_export`, `request` is already a parameter, so add the dependency next to it. There is no object-scope check to copy, so add nothing else. Then add a regression test: with auth on, RBAC on and `rbac.denies={analyst_tier1:{cases:[read]}}`, each of these routes returns 403 for a Tier 1 user and 200 for a SOC manager.

### B71. The "Skip to main content" link takes keyboard users away from the page they are on, to Overview

- Area: a11y-phone / keyboard / routing
- Severity: high
- Location: `webui/src/soc/AppShell.tsx:1425`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The skip link is `<a href="#socMain">` (AppShell.tsx:1424-1433), and the Console routes by hash. Activating it sets `location.hash` to `#socMain`. `routeFromLocation` (router.tsx:354-363) maps any unknown id to 'overview'. Live run at 1440x900 with the seeded demo: on #/cases, one Tab then Enter changes the URL to http://127.0.0.1:6005/#socMain, the breadcrumb reads 'Agentic SOC/Overview', the h1 reads 'Cyber Defence Center', and the next Tabs land on 'Last 24h, time range' and 'Auto-refresh interval'. The same happens on #/case_manager?caseId=demo-hitl-00000539-0000, and the open case is lost. At 390x844 focus lands on #socMain and the next Tab restarts at the skip link. App.smoke.test.tsx:102-118 only checks the href and the tabindex of the target, never what activating the link does. Wizard.tsx:504 uses the same pattern (`href="#setup-main"`); it was not exercised live. Screenshot: <scratchpad>/round16/bugs/a11y-phone/skiplink-cases.png

**Failure scenario.**

A keyboard or screen-reader analyst opens a case in Case Manager or a filtered Cases list. The skip link is the first Tab stop on every page. Pressing it to get past the navigation drops them on the Cyber Defence Center and loses the selected case. WCAG 2.4.1 (Bypass Blocks) fails in practice, and there is an unexpected change of context (3.2.1/3.2.2).

**Proposed fix.**

Keep the anchor, but handle the click: `onClick={(e) => { e.preventDefault(); document.getElementById('socMain')?.focus(); }}`, with `scrollIntoView` if needed. Never write the fragment into the hash. Do the same for the Wizard's `#setup-main`. Extend the smoke test to click the link and assert that `location.hash` is unchanged and that `document.activeElement` is #socMain.

**Skeptic's verdict (first paragraph).**

Confirmed, and reproduced against the real router. The skip link is a plain anchor `<a href="#socMain">` with no click handler (webui/src/soc/AppShell.tsx:1424-1433). The Console routes on the hash. Activating the link does a standard fragment navigation, so `location.hash` becomes `#socMain` and `hashchange` fires. The RouterProvider listener (webui/src/soc/router.tsx:557-606) then calls `routeFromLocation()` (router.tsx:354-363). `rawPageOf('#socMain')` is `socMain`, which is not a page id, so it resolves to `overview`. Because the page changed, `setOpts(route.opts)` sets the options to undefined and the open case is lost.

**Skeptic's minimal fix.**

In webui/src/soc/AppShell.tsx, keep the anchor and its href, and handle activation in code so the fragment never reaches the hash router:

<a href="#socMain" onClick={(event) => {
  event.preventDefault();
  const main = document.getElementById('socMain');
  main?.focus();
  main?.scrollIntoView?.({ block: 'start' });
}} ...>Skip to main content</a>

`#socMain` already has tabIndex={-1}, so focus() works. Apply the same handler to the Wizard's skip link (webui/src/soc/pages/Wizard.tsx:503-508), targeting `setup-main`. Extend App.smoke.test.tsx: start at `#/case_manager?caseId=...`, click the skip link, and assert that `window.location.hash` is unchanged, the route is still case_manager with the same caseId, and `document.activeElement` is #socMain.

### B72. Audit log list cuts off the Actor and Summary columns between 640 and about 1000 px; the page scrolls sideways near 768 px

- Area: a11y-phone / reflow
- Severity: medium
- Location: `webui/src/soc/pages/Audit.tsx:215`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The layout is picked from the viewport (`useMediaQuery('(max-width: 639.98px)')` and `'(min-width: 1280px)'`, Audit.tsx:215-217), not from the width the list actually has. The 'medium' layout uses fixed columns of 9.5rem + 8.5rem + 14rem + 9rem = 656 px plus Summary (AuditTable.tsx:354-362) with `table-layout: fixed`, inside a `surface-panel min-w-0 overflow-clip` panel. From 768 px the 240 px docked rail leaves 480-700 px. Measured visible width of the Actor column out of its 144 px, and of Summary: 640: 80/144, Summary 0; 700: 140/144, Summary 0; 780: 0/144, Summary 0 (Event 204 of 224); 800-940: 0 to 140 of 144, Summary 0; 960: Summary 16; 1000: Summary 56. At 768 the document scrollWidth is 792 (24 px page scroll, from the rows' sr-only spans escaping the clip). This holds in both themes. AuditTable.tsx:7-9 states that nothing scrolls sideways. Screenshots: <scratchpad>/round16/bugs/a11y-phone/light-768-audit.png, <scratchpad>/round16/bugs/a11y-phone/audit-900-columns-cut.png, <scratchpad>/round16/bugs/a11y-phone/audit-800-event-cut.png

**Failure scenario.**

An auditor on an iPad (768/810/820 portrait), or on a laptop window snapped to half width, opens the Audit log. Actor (who did it) and Summary (what changed) are invisible or cut, with no scroll to reach them. At 768 the whole page also wobbles sideways by 24 px. The only route to the actor is opening each row's inspector.

**Proposed fix.**

Pick the layout from the panel's own width (a ResizeObserver or a container query on the list), not the viewport. Use 'phone' (3 columns) below about 700 px of list width and 'medium' only when 656 px plus a minimum Summary width (about 160 px) fits. Alternatively, let Summary be the flexible column and give Event/Actor `minmax` widths. Add a Vitest with a mocked container width covering 480-760 px.

**Skeptic's verdict (first paragraph).**

I reproduced this on the live demo (ports 8931 and 6031, signed in as Admin, #/audit, Playwright Chromium). Both measurements match the reporter's exactly.

**Skeptic's minimal fix.**

1. In `webui/src/soc/pages/Audit.tsx`, choose the table's layout from the measured width of the list, not the viewport.
   - Put a ref on the list Panel (or wrap AuditTable in a div with a ref).
   - Measure it with a ResizeObserver hook. Reuse `useElementWidth` from `webui/src/soc/chat/composer/useElementWidth.ts`, moved to `soc/hooks`.
   - Use `tableLayout = w == null ? viewportLayout : w < 816 ? 'phone' : w < 992 ? 'medium' : 'wide'`. 816 is the 656 px of medium columns plus a 160 px minimum Summary. 992 is the 832 px of wide fixed columns plus 160.
   - Pass `tableLayout` to `<AuditTable layout=...>` only. Keep the viewport `phone` and `wide` for the control band and the inspector's `modal`/`phone` props.
2. Contain the absolutely positioned sr-only spans so they cannot widen the document. Add `relative` to the AuditTable root (`<div className={cn('relative min-w-0', className)} data-audit-list="">`, AuditTable.tsx:345), or to the Actor cell. Their containing block is then inside the `overflow-clip` panel.
3. Add a Vitest that stubs ResizeObserver to report list widths of 480, 656, 812 and 1000. It should check that 480 and 656 render the three-column phone layout, 812 does too, and 1000 renders medium with Actor and Summary headers.

### B73. The phone navigation sheet drops focus to <body> when it closes, and after picking a destination

- Area: a11y-phone / focus management
- Severity: medium
- Location: `webui/src/soc/AppShell.tsx:1442`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The mobile Sheet (AppShell.tsx:1442-1472) opens from a plain `onClick` Button (1508-1515), not a `SheetTrigger`. Radix Dialog's default onCloseAutoFocus focuses `context.triggerRef`, which stays null here, so focus falls to body. `navigateFromMobile` (1189-1195) only closes the sheet and navigates. The desktop handler `navigateFromDesktop` (1209-1215) moves focus to #socMain. Live run at 390x844: Open navigation, then Escape, gives activeElement BODY. Open navigation, then Enter on 'Cases', gives BODY at #/cases, and the next Tab goes to 'Skip to main content' (the document start). The Console controls sheet wraps its button in `SheetTrigger` (1832-1841) and correctly returns focus to 'Open console controls…'.

**Failure scenario.**

On a phone with a keyboard or switch control, or with VoiceOver or TalkBack, every page change through the menu leaves focus nowhere. Assistive technology reads nothing, and the next Tab restarts at the top of the document. Combined with the skip-link defect, the obvious next key press (Enter on the skip link) navigates away to Overview.

**Proposed fix.**

Wrap the hamburger in `<SheetTrigger asChild>`, or give the SheetContent `onCloseAutoFocus` that focuses the hamburger. In `navigateFromMobile`, after closing, `requestAnimationFrame(() => document.getElementById('socMain')?.focus())` as the desktop path does, and prevent the sheet's own close autofocus in that case. Add a test for Escape returning focus to 'Open navigation' and for navigation focusing #socMain.

**Skeptic's verdict (first paragraph).**

I tried to refute this and could not. I reproduced it in jsdom.

**Skeptic's minimal fix.**

In webui/src/soc/AppShell.tsx:

1. Add two refs: `const mobileNavOpenerRef = React.useRef<HTMLButtonElement>(null);` and `const mobileNavNavigatedRef = React.useRef(false);`.
2. Put `ref={mobileNavOpenerRef}` on the "Open navigation" Button (around line 1508).
3. In `navigateFromMobile`, set `mobileNavNavigatedRef.current = true;` before `setMobileNavOpen(false)`.
4. Add this handler to the mobile `<SheetContent>`, next to `onOpenAutoFocus`. Calling preventDefault inside it stops Radix's own handler, which focuses the null trigger, through composeEventHandlers:

```tsx
onCloseAutoFocus={(event) => {
  event.preventDefault();
  const navigated = mobileNavNavigatedRef.current;
  mobileNavNavigatedRef.current = false;
  if (navigated) {
    window.requestAnimationFrame(() => document.getElementById('socMain')?.focus());
  } else {
    mobileNavOpenerRef.current?.focus();
  }
}}
```

5. Add two tests to appshell.search.test.tsx at the phone viewport:
   - Open the menu, press Escape: focus returns to the "Open navigation" button.
   - Open the menu, click nav-cases: `document.getElementById('socMain')` has focus.

### B74. A sticky first column hides the focused control in DataTable on phones (WCAG 2.2 SC 2.4.11)

- Area: a11y-phone / focus visibility
- Severity: medium
- Location: `webui/src/soc/components/DataTable.tsx:335`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

`stickyFirstColumn` makes the first header and cell `sticky left-0 z-[1] bg-card` (DataTable.tsx:328-335, 785, 967). The horizontal scroller has no `scroll-padding-inline-start`, so when Tab focuses a control in a later column, the browser scrolls it to the scroller's left edge, underneath the sticky column. Live at 390x844: Team activity People table, the 'Acknowledged' sort button sits at x 139-251 under the sticky 'Person' header at 16-236 (only a 15 px sliver shows), and 'Escalated' at 154-236 is completely hidden. Cost 'Detailed cost ledger by model': 'Tokens' at 162-229 sits under the sticky 'Model' column at 16-208. elementFromPoint at the focused control's centre returns the sticky TH. Users of the prop: TeamActivity.tsx:438, Cost.tsx:985, ReportsLibrary.tsx:756. This is separate from the recorded person-sheet Per day limitation. Screenshot: <scratchpad>/round16/bugs/a11y-phone/team-390-focus-Acknowledged.png

**Failure scenario.**

A keyboard user on a phone or narrow window tabs through the People or cost table's sort buttons. The focused button and its focus ring are hidden under the sticky name column, so they cannot see what Enter will sort.

**Proposed fix.**

Set `scroll-padding-inline-start` on DataTable's scroll container to the sticky column's width when `stickyFirstColumn` is on. Measure it with a ResizeObserver into a CSS variable, or set `scroll-margin-inline-start` on non-sticky cells. Add a test that focuses a later header button at 390 and asserts its rect starts right of the sticky column.

**Skeptic's verdict (first paragraph).**

The defect is real. I confirmed it from the code and reproduced it on its own.

**Skeptic's minimal fix.**

Fix this in webui/src/soc/components/DataTable.tsx using WCAG technique C43, the same pattern PageHeader already uses for its vertical band.

When `stickyFirstColumn` is on, set the horizontal scroller's `scroll-padding-inline-start` to the right edge of the sticky leading cells, measured from the scroller. That covers the checkbox column as well when the table is selectable. Keep it current with a ResizeObserver. Use the existing `scrollEl` state (:591) and mark the sticky data header cell, for example `data-sticky-lead` on the `<TableHead>` at :816.

```tsx
React.useLayoutEffect(() => {
  if (!stickyFirstColumn || !scrollEl) return;
  const lead = scrollEl.querySelector<HTMLElement>('thead th[data-sticky-lead]');
  if (!lead) return;
  const apply = () => {
    // The sticky cell is pinned, so its rect relative to the scroller is stable at any scrollLeft.
    const edge = lead.getBoundingClientRect().right - scrollEl.getBoundingClientRect().left - scrollEl.clientLeft;
    scrollEl.style.setProperty('scroll-padding-inline-start', `${Math.max(0, Math.round(edge))}px`);
  };
  apply();
  const ro = new ResizeObserver(apply);
  ro.observe(lead);
  ro.observe(scrollEl);
  return () => { ro.disconnect(); scrollEl.style.removeProperty('scroll-padding-inline-start'); };
}, [stickyFirstColumn, scrollEl, displayColumns, selectable]);
```

Do not use `offsetLeft` here. On a sticky `th` it changes with scrollLeft.

Add a DataTable test with `stickyFirstColumn`, a mocked rect on the sticky `th` and a stubbed ResizeObserver. It should assert that the scroller gets `scroll-padding-inline-start` equal to the sticky edge (the checkbox width plus the lead width when selectable), and that the property is removed when the prop is off or the table unmounts. If the browser lane can, also add a check at 390 px that focuses a later header sort button and asserts its rect starts right of the sticky column.

Add a line to docs/development/ui-standard.md, next to the existing 2.4.11 band rule, saying that sticky leading columns pad the horizontal scroller the same way.

### B75. Popover dialogs have no accessible name (axe aria-dialog-name, serious)

- Area: a11y / naming
- Severity: low
- Location: `webui/src/soc/components/NotificationBell.tsx:439`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Radix PopoverContent renders role="dialog", but these instances get neither aria-label nor aria-labelledby. axe with the overlay open flags the notification bell popover (NotificationBell.tsx:439; its 'Notifications' heading is a <p> with no id), the Team activity range popover (team/TeamRangeControl.tsx:57), and the Audit Event and More filters popovers (audit/AuditFilters.tsx:136, 427), in both themes at 390 and 1440. A static scan finds 17 PopoverContent usages without aria-label: HelpTip.tsx:108, CaseTasks.tsx:191, TimeRangePicker.tsx:481, audit/AuditFilters.tsx:136/216/427/482, SavedViewsBar.tsx:194, NotificationBell.tsx:439, DemoIndicator.tsx:133, runbooks/run/WhyAttached.tsx:199, AppShell.tsx:596/784/1793, team/TeamRangeControl.tsx:57, Cases.tsx:2530/2570. The ones spot-checked carry no aria-labelledby either.

**Failure scenario.**

A screen-reader user opens the bell or a time-range or filter popover and hears only 'dialog', with no name, so they cannot tell which panel they are in.

**Proposed fix.**

Give each PopoverContent an `aria-label` (for example 'Notifications', 'Time range', 'Event filter', 'More filters'), or `aria-labelledby` pointing at the popover's visible heading. Consider an eslint/jsx-a11y custom rule or a wrapper requiring a label prop.

**Skeptic's verdict (first paragraph).**

The defect is real. Note the tree is at 3cd362c (the "Journal: Round 16 start" commit), not 3cfd5c0, but the files are the same.

**Skeptic's minimal fix.**

Name each of the 17 `PopoverContent` instances.

- **Where there is a visible heading**, use `aria-labelledby`. In NotificationBell, add `const titleId = React.useId()`, put `id={titleId}` on the "Notifications" `<p>` (NotificationBell.tsx:441) and pass `aria-labelledby={titleId}` to `PopoverContent` at line 439.
- **Elsewhere**, add an `aria-label` that matches the trigger:
  - AuditFilters.tsx:136: "Event filter"
  - AuditFilters.tsx:427: "More filters", which the ui-standard requires
  - AuditFilters.tsx:216 and 482: their facet names
  - TeamRangeControl.tsx:57 and TimeRangePicker.tsx:481: "Time range"
  - SavedViewsBar.tsx:194: "Saved views"
  - HelpTip.tsx:108: the help topic's title
  - CaseTasks.tsx:191, DemoIndicator.tsx:133, WhyAttached.tsx:199, AppShell.tsx:596/784/1793 and Cases.tsx:2530/2570: their visible heading or trigger name

To stop it coming back, add a unit test that opens each popover and runs axe. A static check that every `<PopoverContent` carries `aria-label` or `aria-labelledby` would also work. Do not set a generic default name in `ui/popover.tsx`: it would hide missing names rather than fix them.

### B76. The command palette listbox contains role=separator children (axe aria-required-children, critical)

- Area: a11y / ARIA structure
- Severity: low
- Location: `webui/src/soc/components/CommandPalette.tsx:428`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

CommandPalette.tsx:428, 486 and 515 render `<CommandSeparator />` inside `CommandList`. cmdk 1.1.1 renders the list as role="listbox" and the separator as `<div cmdk-separator role="separator">`, which a listbox may not contain. axe reports 'Element has children which are not allowed: [role=separator]' on `div[cmdk-list][role=listbox][aria-label=Suggestions]` at 390 and 1440 in both themes.

**Failure scenario.**

NVDA or JAWS users in the palette can get wrong option counts or positions ('3 of 12'), or the separators read as list items, when arrowing through suggestions.

**Proposed fix.**

Drop CommandSeparator and use the groups' own headings and spacing, or render the separator with `role="none"` / `aria-hidden` (pass `alwaysRender` with an overriding role prop on the ui/command wrapper).

**Skeptic's verdict (first paragraph).**

I reproduced it, and the defect is real. cmdk 1.1.1 (webui/node_modules/cmdk/dist/index.mjs) renders the Separator as `createElement(D.div, {ref, ...u, "cmdk-separator": "", role: "separator"})`. It renders only while the search is empty, unless alwaysRender is set. The List is `role="listbox"` and wraps its children in a role-less `cmdk-list-sizer` div, so to assistive technology the separator is a direct child of the listbox. A listbox may own only option and group elements.

**Skeptic's minimal fix.**

In webui/src/ui/command.tsx, add `aria-hidden` to the cmdk Separator so the purely visual divider is removed from the accessibility tree. That fixes all three palette separators and any future one, and keeps cmdk's empty-search show/hide behaviour. Overriding `role` will not work, because cmdk sets `role` after spreading the caller's props:

```tsx
const CommandSeparator = React.forwardRef<...>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    aria-hidden
    className={cn('-mx-1 h-px bg-border', className)}
    {...props}
  />
));
```

Optionally, add an axe assertion (`expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations()`) to webui/src/soc/__tests__/command-palette.test.tsx after renderPalette() so this cannot regress. The alternative is to delete the three `<CommandSeparator />` uses in CommandPalette.tsx (lines 428, 486 and 515) and rely on the group headings for visual separation.

### B77. Opening a runbook, or going back to the library, leaves focus on <body> with no announcement

- Area: a11y / focus management
- Severity: low
- Location: `webui/src/soc/pages/Runbooks.tsx:510`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

Runbooks switches between the library and a detail view on the same route (#/runbooks ↔ #/runbooks?id=…). The link that had focus unmounts and nothing takes focus. Live at 390 and 1440: Enter on 'Cloud identity and access key compromise' gives activeElement BODY at #/runbooks?id=cloud-identity-keys. 'All runbooks' (the PageHeader back link, Runbooks.tsx:510) gives BODY. Browser Back gives BODY. Chromium keeps a sequential starting point, so the next Tab reaches 'All runbooks', but no focus target or live region tells assistive technology that the view changed. Case Manager handles the same pattern on phones: focus goes to the case H2 on open and back to the row on return.

**Failure scenario.**

A VoiceOver or NVDA user activates a runbook and hears nothing. Their virtual cursor stays in a document whose content was replaced, and they must hunt for the new heading. The same happens on return to the library.

**Proposed fix.**

On view switch, focus the detail H1 (tabIndex -1) when a runbook opens, and on return focus the row link of the runbook just left (or the library heading), as CaseManager's resolveDialogFocus/row-return does.

**Skeptic's verdict (first paragraph).**

I confirmed this from the code and reproduced it with a temporary vitest. I deleted that test afterwards and `git status --short` is clean.

**Skeptic's minimal fix.**

Copy the Dashboards pattern.

(1) `webui/src/soc/runbooks/editor/RunbookEditor.tsx`: replace the mount-only effect at lines 706-711 with a once-only effect that runs when the page first shows its heading. Keep a ref `const landed = React.useRef(false)` and use:

```
React.useEffect(() => {
  if (landed.current || loadState !== 'ready' || (!isNew && !detail)) return;
  landed.current = true;
  const a = document.activeElement;
  if (initialDetail || !a || a === document.body || !a.isConnected) focusHeading(rootRef.current);
}, [loadState, detail, isNew]);
```

This covers a plain open, an open from Back or Forward, and New runbook, as well as the existing hand-over.

(2) `webui/src/soc/pages/Runbooks.tsx`, in `Runbooks()`: remember which runbook was last open and restore focus on return to the library.

```
const lastOpen = React.useRef<string | null>(null);
React.useEffect(() => {
  if (openId) { lastOpen.current = openId; return; }
  const prev = lastOpen.current;
  if (!prev || libraryState === 'loading') return;
  lastOpen.current = null;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const row = document.querySelector<HTMLElement>(`[data-runbook-link="${CSS.escape(prev)}"]`);
  (row ?? document.getElementById('socMain'))?.focus({ preventScroll: !row });
}, [openId, libraryState]);
```

Add a test to `Runbooks.management.test.tsx` and `RunbookEditor.test.tsx` that asserts `activeElement` is the H1 after an open and the row link after All runbooks or Back.

### B78. Scroll regions with no focusable content: CodeBlock pre and the bare table wrapper (axe scrollable-region-focusable)

- Area: a11y / keyboard scrolling
- Severity: low
- Location: `webui/src/soc/components/CodeBlock.tsx:150`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

CodeBlock renders `<pre class="overflow-auto … max-h-*">` with no tabIndex or label (CodeBlock.tsx:150-156; 37 usages). axe flags it in the Audit inspector's 'Raw record' (AuditInspector.tsx:448-454, max-h-72) at 390 and 1440. The shared ui/table wrapper `relative w-full overflow-auto` (ui/table.tsx:50) is flagged when its rows hold nothing focusable: Agent effectiveness 'Auto-close review by rule' at 390, and the Team person sheet's Per day table. Chromium 153 used here focuses scrollers automatically (Tab reached the Effectiveness scroller), as does Firefox, so the remaining impact is WebKit/Safari.

**Failure scenario.**

A Safari (macOS or iPadOS) keyboard user cannot scroll a long Raw record JSON or a clipped narrow table to read the cut-off columns or lines.

**Proposed fix.**

Give CodeBlock's pre `tabIndex={0}`, `role="region"` and an aria-label (the caption) when it can overflow. In ui/table add an opt-in (or automatic, when overflowing) `tabIndex={0}` plus an aria-label on the wrapper.

**Skeptic's verdict (first paragraph).**

I confirmed the defect from the code and with an axe run in a real browser. It is low severity, the impact is limited to WebKit/Safari, and none of the three known-limitation records lists it.

**Skeptic's minimal fix.**

1. **CodeBlock.tsx** (follow the AddToCaseDialog precedent).
   - Keep a ref on the `<pre>` and measure overflow: `scrollHeight > clientHeight || scrollWidth > clientWidth`, re-measured with a ResizeObserver and whenever the text changes.
   - Only when it overflows, render `tabIndex={0} role="region" aria-label={typeof caption === 'string' ? caption : 'Code'}`. Add `focusRing` to its classes and wrap it in the `/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- a scrollable region must take focus (axe scrollable-region-focusable) */` comment.
   - The overflow gate means the 37 short blocks do not each gain a needless tab stop.

2. **ui/table.tsx.**
   - Add an optional `scrollLabel?: string` prop. When set (and not `unwrapped`), put `tabIndex={0} role="region" aria-label={scrollLabel}` plus `focusRing` on the wrapper div, with the same eslint-disable comment.
   - Pass it at `AutoCloseReviewModule.tsx:149` (for example "Auto-close review by rule, scrollable") and at `PersonSheet.tsx:288`.
   - In PersonSheet, also either drop the extra `<div className="overflow-x-auto">` or pass `unwrapped` to the Table, so only one scroller exists and it is the focusable one.

3. **Test.** Add a jest-axe or unit test asserting the wrapper gets `tabIndex` 0 and its name when `scrollLabel` is set. Do the same for CodeBlock with the overflow measurement mocked.

### B79. Phone Audit list cuts every timestamp's seconds ("24 Nov 20:57:…")

- Area: a11y-phone / layout
- Severity: low
- Location: `webui/src/soc/components/audit/AuditTable.tsx:355`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

In phone layout the Time column is `w-[8rem]` with `px-3` (AuditTable.tsx:355, 275), leaving 104 px for '24 Nov 21:45:52', which needs about 110 px at text-sm. At 390 every row reads '24 Nov 20:57:…' in both themes, while the Outcome column (also 8rem) has spare room. The full ISO time is only in `title`, which touch screens cannot show. Screenshots: <scratchpad>/round16/bugs/a11y-phone/light-390-audit.png, <scratchpad>/round16/bugs/a11y-phone/audit-390-time-truncated.png

**Failure scenario.**

On a phone, an auditor reviewing a burst of sign-ins or setting changes in the same minute cannot tell the events apart or order them by second.

**Proposed fix.**

Widen the phone Time column (for example 8.75rem) and narrow Outcome (glyph plus short label), or use tabular-nums with `text-xs` for the time on phones.

**Skeptic's verdict (first paragraph).**

Confirmed by code, measurement and the existing screenshots. On a phone (any width below 640 px, Audit.tsx:215-217), the Time column is `w-[8rem]` (128 px, AuditTable.tsx:355). The cell uses `px-3` (timePad, AuditTable.tsx:275) and `truncate` plus `numeric`, which means tabular-nums and nowrap (AuditTable.tsx:286, ui/table.tsx:166). That leaves 104 px of content at text-sm (ui/table.tsx:45). formatRowTime prints "DD Mon HH:MM:SS" (audit-model.ts:350-355), the format SPEC Round 14 §4.5 (line 1077) requires: Time (tabular, "25 Oct 15:09:15"). I measured it in headless Chrome with the bundled Inter Variable latin wght woff2, tabular-nums, 14 px and the body feature settings. "24 Nov 21:45:52" is 114.2 px, "30 Dec 23:59:59" is 113.9 px and "1 Nov 11:11:11" is 105.1 px, so every phone row is ellipsized before its seconds. The prior-year form "5 Jan 2025 03:04:05" is 142.8 px. Both screenshots (light-390-audit.png, audit-390-time-truncated.png) show "24 Nov 20:57:…" on every row. Group rows span all columns and are not affected. None of known-limitations.md, ROADMAP §J or Round 15 SPEC §8.3 records this.

**Skeptic's minimal fix.**

In webui/src/soc/components/audit/AuditTable.tsx, recordCells (line 286), stop truncating the time on a phone and let it wrap at its space into date and clock lines. Phone rows are already two lines tall because Event uses line-clamp-2. Change the cell to `className={cn('relative text-muted-foreground', phone ? 'whitespace-normal' : 'truncate', timePad, selected && SELECTED_BAR)}`. twMerge lets the later `whitespace-normal` override numeric's `whitespace-nowrap`. If a deterministic break is preferred, render `<time>` as two block spans split at the last space of formatRowTime's output. Keep the 8rem Time column and the 8rem Outcome column, which the Outcome-width test pins. At 104 px, "24 Nov" / "21:45:52" and "5 Jan 2025" / "03:04:05" both fit. Add an AuditTable phone test that checks the Time cell no longer has `truncate`.

### B80. Case evidence caption "Untrusted source data" is clipped mid-word with no ellipsis at 390 and 768

- Area: a11y-phone / layout (#9 trust label)
- Severity: low
- Location: `webui/src/soc/components/CodeBlock.tsx:128`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

The CodeBlock header caption is `<span className="truncate …">{caption}</span>` (CodeBlock.tsx:128). StageTimeline passes an inline-flex span (StageTimeline.tsx:305-309), and text-overflow cannot ellipsize inside an inline-flex child, so the text is hard-cut. Measured in Case Manager Overview 'What happened': scrollWidth 219 against clientWidth 207 at 390 and 209 at 768. It reads 'evidence · Untrusted source dat' butting into 'Copy'. Screenshots: <scratchpad>/round16/bugs/a11y-phone/dark-390-case_manager.png, <scratchpad>/round16/bugs/a11y-phone/dark-768-case_manager.png

**Failure scenario.**

On a phone or tablet the trust marker on raw source evidence reads as a broken word next to the Copy button, which weakens the untrusted-data signal on exactly the content it guards.

**Proposed fix.**

Let the caption wrap (drop `truncate`, allow `flex-wrap` in the header), or make the caption's inner span `inline` / `min-w-0 truncate` so the ellipsis renders. Shorten it to 'Untrusted' below sm.

**Skeptic's verdict (first paragraph).**

Confirmed from the code, from both screenshots and from a separate Chrome reproduction.

**Skeptic's minimal fix.**

Let the trust marker wrap instead of truncating. In StageTimeline.tsx StoryStep (lines 305-311), change the caption wrapper from `inline-flex items-center gap-1.5 font-sans` to `inline-flex min-w-0 flex-wrap items-center gap-x-1.5 font-sans whitespace-normal`. Keep the Lock icon and "Untrusted source data" together in their own `inline-flex items-center gap-1 whitespace-nowrap` span, so the marker drops to a second line as one unit rather than being clipped.

The more general fix is in CodeBlock.tsx:127-128. Make the header `flex items-start justify-between gap-2` and give the caption `min-w-0 break-words` in place of `truncate`. AuditInspector's string captions "Tool output · contains untrusted log data" and "Prompt excerpt · contains untrusted log data" are also trust labels; with the CodeBlock fix they wrap instead of ending in an ellipsis.

Add a StageTimeline test asserting that the caption container no longer carries `truncate`, or that the wrapper allows wrapping.

### B81. Phone text inputs are 13 px, which triggers iOS Safari's zoom on focus (not reproduced: no WebKit here)

- Area: a11y-phone / input
- Severity: low
- Location: `webui/src/ui/input.tsx:13`
- Owning package: WP15F
- Merged into: none
- Skeptic verdict: real

**Evidence.**

ui/input.tsx:13 and ui/textarea.tsx:12 use `text-sm`, which computes to 13px at 390 for 'Search cases', 'Ask a question' (chat composer), 'Search the audit log' and 'Search runbooks'. iOS Safari zooms the page on focus of any field under 16px. index.html:5 correctly leaves zoom enabled (no maximum-scale), so the zoom happens and leaves the layout scaled. This was not reproduced, because only Chromium is installed in this sandbox (/opt/pw-browsers).

**Failure scenario.**

An iPhone user taps the case search or chat composer. Safari zooms in, the page then scrolls horizontally, and the user must pinch out after every field.

**Proposed fix.**

Use 16px for inputs on coarse pointers or small screens (for example `text-base sm:text-sm`, or `@media (pointer: coarse) { input, textarea, select { font-size: 16px } }`). Verify on WebKit (Playwright webkit) in CI if available.

**Skeptic's verdict (first paragraph).**

I confirmed this from the code but could not reproduce it on a device. The sandbox has no WebKit, so the iOS focus zoom itself is not observed. Everything it depends on is in the source:

**Skeptic's minimal fix.**

Add one coarse-pointer rule to the `@layer base` block of `webui/src/styles/theme.css`. A per-primitive class swap would not cover the raw composer `<textarea>`, and call sites that pass an explicit `text-sm` (AuditFilters) would override it.

```css
@media (hover: none) and (pointer: coarse) {
  input:not([type='checkbox']):not([type='radio']):not([type='range']):not([type='file']),
  textarea,
  select {
    font-size: max(1rem, 16px) !important; /* iOS Safari zooms on focus below 16px */
  }
}
```

The `!important` is needed because a `.text-sm` class outranks an element selector. The rule only applies on touch screens, so desktop density is unchanged, it adds no arbitrary text-size utility, and pinch-zoom stays enabled. Do not use `maximum-scale=1`, which disables zoom on Android.

Add a WebKit (Playwright webkit) focus check at 390 px in CI if one is available.
