# WP16 browser checks: receipt

Package WP16X runs the browser checks of SPEC §4.6 WP16 and §5.4 on the integrated tree and
records what they found. It changes no product code. Each failure is written up with its
repro for the orchestrator to route.

## Setup

- **Tree.** `claude/round16` at `08db702` ("Journal: XFCM and XFB2 merged; integrated suites
  run"), checked out as `r16-wp16x`. Release identity on screen: `v0.2.0 · Testing`.
- **Demo.** `BACKEND_PORT=8974 WEBUI_PORT=5974 DEMO_MODE=seeded ./scripts/run-demo.sh`: the
  seeded Demo with sign-in on, in-memory state, the Vite dev server and the Help Center bundle
  built by `predev`. Signed in as `Admin` / `Admin@123`.
- **Browser.** Playwright 1.63.0, headless Chromium build 1243, device scale factor 2.
  Viewports 1440 by 900 and 390 by 844. axe-core 4.12.1 with its default rules; a finding
  counts when its impact is serious or critical.
- **Themes.** Light and dark are set on the account (`theme_mode`), because the account's
  saved theme overrides the browser scheme. System is `theme_mode: system`. In this Demo the
  organization default theme is dark (`/api/branding` has `default_theme: dark`), so System
  resolves to dark for a signed-in account, and the sign-in page's third appearance button
  reads "Use the organization default theme". Every capture recorded whether `<html>` had the
  `dark` class; the 54 rows of the page sweep all matched their theme.
- **Screenshots.** 94 PNG files in the build scratchpad folder `round16/shots/WP16X/`, not in
  the repository. File names say the surface, the width and the theme.
- **Scripts.** The probes are Node scripts in the build scratchpad (`wp16x/`), outside the
  build. Check 1 uses the committed `acceptance/measure-case-manager.mjs` unchanged.

## Summary

| # | Check | Result |
|---|---|---|
| 1 | Case Manager geometry (`measure-case-manager.mjs`) | PASS |
| 2 | One EventSource per tab | PASS |
| 3 | Nothing running on the sign-in page after it settles; Remember me without a duration | PASS |
| 4 | What's new once after an update, never for a new account | PASS |
| 5 | The AI chip across a Reinvestigate | PASS, with two Demo limits noted |
| 6 | The risk popover and panel, recomputed by hand | PASS |
| 7 | `/docs/0.1/` redirects to `/docs/0.2/` keeping the path and the hash | PASS |
| 8 | axe serious and critical: zero on Case Manager, a case page, sign-in and What's new | FAIL: one node on the Response tab in light |
| 9 | No horizontal overflow, no unexplained console errors | PASS |

## 1. Case Manager geometry

Command: `node docs/research/2026-11-round16/acceptance/measure-case-manager.mjs --url
http://127.0.0.1:5974 --review-case demo-00000539-0007`. The normal case is the first row of
the Active queue; the review case is CASE-000034, a pending auto-close review sample.

| Viewport | Case | Frame top | Band | Header | First content (`case-tab-first`) |
|---|---|---|---|---|---|
| 1440 by 900 | first row | 72 | 92 | 119 | 207 |
| 1440 by 900 | CASE-000034 (review) | 72 | 92 | 119 | 207 |
| 390 by 844 | first row | 72 | 92 | 119 | 207 |
| 390 by 844 | CASE-000034 (review) | 72 | 92 | 119 | 207 |

Limits (A2, WP02, WP03): frame top 72, band 92 without the AI notice (at most 112 with it),
header at most 120, first content at most 210 at both sizes. All met. The same values as the
WP16C review recorded in SPEC §8.1.

At 1440 by 900 with the navigation collapsed (64 px), the case facts show as a column:
`case-facts-column` is 272 px wide at x 1,152, its top at 191 px, the header's bottom edge.

Note on running the script: it does not dismiss the What's new welcome. While the welcome is
open its modal hides the page from the accessibility tree, so the phone step cannot find
"Back to case queue" and times out. The welcome showing there is correct (`#/case_manager` is a
landing page), so the account's marker was made current before the run.

## 2. One EventSource per tab

An init script wrapped `window.EventSource` and counted constructions, closes and the
streams open at each moment. In one tab: Overview, Case Manager, a case on its Activity tab
(`#/case_manager?caseId=demo-recent-00000539-0002&tab=collab`), Inbox, Overview again; then a
fresh load of each page. Each reading was taken 3.5 s after arriving.

| Step | 1440: open now | 1440: built, closed | 390: open now | 390: built, closed |
|---|---|---|---|---|
| Overview | 1 | 2, 1 | 1 | 1, 0 |
| Case Manager | 1 | 3, 2 | 1 | 2, 1 |
| Case page (Activity) | 1 | 4, 3 | 1 | 3, 2 |
| Inbox | 1 | 5, 4 | 1 | 4, 3 |
| Overview again | 1 | 5, 4 | 1 | 5, 4 |
| Fresh Case Manager | 1 | 3, 2 | 1 | 2, 1 |
| Fresh case page | 1 | 3, 2 | 1 | 2, 1 |
| Fresh Overview | 1 | 2, 1 | 1 | 1, 0 |
| Fresh Inbox | 1 | 2, 1 | 1 | 2, 1 |

Exactly one stream was open at every reading. A new stream opens when a page's topic set
changes, and the old one closes once the new one is open: the most seen at once was 2, and in
the recorded handovers the two overlapped for 16 ms at 1440 and 12 ms at 390. The case page's
topic set was `cases`, `cases:<id>`, `chat`, `inbox`, `investigations`, `jobs`,
`notifications` and `runbooks` at 1440, and the same without `inbox` and `notifications` on
the phone, where the bell is not mounted.

## 3. The sign-in page after it settles

An init script wrapped `setTimeout`, `setInterval` and `requestAnimationFrame`. On each step
the page settled (network idle), then 2 s more, then the callbacks that ran during the next
8 s were counted, and `document.getAnimations()` was read for running animations. 2 steps by
3 themes by 2 viewports:

- `setTimeout` callbacks 0, `setInterval` callbacks 0, `requestAnimationFrame` callbacks 0,
  running animations 0, in all 12 windows.
- One interval stays registered: the Vite dev client's 30 s ping, set by `@vite/client`
  at 107 ms; over 70 s it fired twice. It exists only on the dev server, never in a built
  Console. No product code holds a timer.
- The Remember me row (password step) reads "Remember me": no digits, no duration word,
  no `aria-describedby`, enabled (the Demo runs on loopback), in all six contexts.
- axe: 0 serious or critical in all 12 runs; no horizontal overflow; no console errors.

## 4. What's new once after an update

| Step | Seen |
|---|---|
| A. The seeded Admin has no marker (predates What's new); sign in | "Welcome to Agentic SOC 0.2.0", 5 highlights |
| Got it | marker `0.2.0.2026-12`; focus on `#socMain` |
| Reload | nothing |
| B. Marker set to the older `0.2.0.2026-11-13`; reload | "What's new in Agentic SOC 0.2.0", "2 updates since you last looked.", 5 highlights |
| Got it, then reload, then Case Manager | nothing, nothing |
| Same account in a new browser, signed in again | nothing |
| C. Older marker again (dark scheme); closed with Escape | marker current; a reload shows nothing |
| D. Older marker; a fresh load of a deep link to a record (`?caseId=`) | nothing (deferred) |
| Then the Overview landing page | the dialog |
| Phone 390 by 844, older marker; Got it; reload | the dialog once, then nothing |
| E. A new account made by the Admin (`POST /api/users`), signed in, forced password change set | marker already `0.2.0.2026-12`; no dialog on landing or after a reload |

## 5. The AI chip across a Reinvestigate

CASE-000043 (`demo-recent-00000539-0001`), 1440 by 900, light. R opened "Re-run the
investigation"; Reinvestigate answered `202` with state `queued`. A sampler read the page
every 150 ms. The run took 8.3 s (registry: started 08:30:14.23, finished 08:30:22.54).

| Moment | Header chip | Queue row mark | Case Manager count |
|---|---|---|---|
| 0.6 s after Reinvestigate | appears | | |
| while the run works (8 readings) | "AI working · 0:00", ticking each second to "AI working · 0:07" | "AI working" | 1 |
| the run ends | "AI finished" (success tint) | gone | gone |
| 5.8 s later | gone (the 6 s tint ended) | | |

- **Popover** (named "AI investigation running"): the five steps with 1 and 2 done and 3
  "Looking up evidence" turning, "You started it. Started 1 second ago. The time cap for an
  investigation is 2 minutes.", the note that a close made now is replaced and what is kept,
  and "See its steps in the audit log".
- **Close dialog during the run** (C): "An AI investigation is running on this case. When it
  finishes, its result replaces a close you make now." Submit stays usable: with a disposition
  and the open-steps reason filled, "Close case" and "Close & next" were enabled (checked on
  CASE-000046 in dark). Kept open past the run's end, the note turned into "The AI
  investigation finished. The verdict is now needs human review. Check it before you close."
  The dialog was cancelled.
- **Inbox**: one new item, "AI investigation finished on case CASE-000043", "Verdict: Needs
  human review. Status: Open, awaiting analyst.", with Open case.
- **Five runs at once** (`wait: false` on five open cases): all five rows showed "AI working"
  and the navigation count read 5; all five ended about 8.2 s later.
- **Phone, 390 by 844, light and dark**: the chip is the ring alone (26 px) with the name "AI
  working. Show the AI investigation"; its popover fits; no horizontal overflow.
- **Hold-off**: a run started from this page's own dialog shows its chip at once (the dialog
  hands the run to the store, by design); a run learned from frames showed after 1.08 to 1.13 s.

Two Demo limits, not defects:

- **AI queued** and the band notice (`ai-queue-notice`) cannot be produced in the seeded Demo.
  The Demo pipeline runs without the investigation gate (`routes_investigations.py`: "The Demo
  pipeline runs without the gate"), so five manual runs against a cap of 3 all ran at once.
  The queued state is covered by the WP09 unit tests.
- Only the "You started it" popover line is reachable here; the other four trigger lines need
  other people or a background job.

## 6. The risk popover and panel

The hover line and the click panel of the header's Risk chip (on the phone, the case facts'
score, because the strip hides Risk below its width), against a hand recomputation from the
stored `risk_breakdown.inputs` with the formulas of `engine/risk.py`:
volume `100 x ln(1 + n) / ln(51)`, velocity `100 x n / (window / 60) / 10` when n is at least 3,
reputation and asset clamped to 0 to 100, diversity `100 x rules / 5`, weights 0.25, 0.20,
0.30, 0.15 and 0.10 over 1.00.

| Case | Inputs | By hand | Console |
|---|---|---|---|
| CASE-000041, 1440 light | 8 events over 434.875 s (1.1038 a minute), 1 rule, reputation 100 (enrichment), asset 0 | 55.8831, 11.0377, 100, 20, 0; 13.9708 + 2.2075 + 30 + 3 + 0 = 49.1783, so 49.18, shown 49 | hover "Risk 49.18 = (0.25 x 55.88 + 0.20 x 11.04 + 0.30 x 100 + 0.15 x 20 + 0.10 x 0) / 1.00."; panel "Risk 49", Shown `floor(49.18 + 0.5)` = 49 |
| CASE-000040, 1440 dark | 3 events over 1,080.666 s (0.1666 a minute), 1 rule, reputation 0 (not an IP), asset 0 | 35.2583, 1.6656, 0, 20, 0; 8.8146 + 0.3331 + 3 = 12.1477, so 12.15, shown 12 | hover "Risk 12.15 = (0.25 x 35.26 + 0.20 x 1.67 + 0.30 x 0 + 0.15 x 20 + 0.10 x 0) / 1.00."; panel "Risk 12" |
| CASE-000045, 390 light | 5 events over 40.8 s (7.3529 a minute), 1 rule, reputation 0 (enrichment), asset 0 | 45.5707, 73.5294, 0, 20, 0; 11.3927 + 14.7059 + 3 = 29.0986, so 29.10, shown 29 | panel "Risk 29", steps 45.57, 73.53, 0, 20, 0, weighted 29.1 |

Every factor, total and shown value matches, and each panel's step rows show the same
arithmetic with the recorded inputs. axe on each open panel: 0 serious or critical.

## 7. The `/docs/0.1/` redirect stubs

Every page of the 0.1 line in the built bundle (90 pages) was opened as
`/docs/0.1/<page>#wp16x-anchor`: 90 of 90 landed on `/docs/0.2/<page>#wp16x-anchor`.
`/docs/0.1/analyst/chat/#conversation-width` landed on its heading (102 px from the top).
`/docs/0.1`, `/docs/0.1/`, `/docs/` and `/docs/installed/` land on `/docs/0.2/`. A query
string is not carried (`/docs/0.1/getting-started/quickstart/?q=1#install` lands on
`/docs/0.2/getting-started/quickstart/#install`); the check asks for the path and the hash only.

## 8. axe serious and critical

| Surface | Runs | Serious or critical |
|---|---|---|
| Sign-in, both steps | 12 (3 themes by 2 viewports) | 0 |
| Case Manager | 6 | 0 |
| Case page, each of the six tabs | 36 | 2 runs with 1 node each (below) |
| What's new page | 6 | 0 |
| What's new dialog | 6 | 0 |
| Risk panel open | 3 | 0 |

No moderate or minor violation was reported either.

**FAIL: the Response tab's phase caption in light.** On a case with a runbook run, the active
phase tab's caption (for example "3/3 · Complete") is `text-muted-foreground` (#5a6272) on the
active tab's `bg-accent` (#d4d6dd): 4.22:1 for 12 px text, below 4.5:1. axe rule
`color-contrast`, target `#radix-...-trigger-triage > .mt-1 > .min-w-0`. It holds after 6 s
and under reduced motion, at 1440 by 900 and 390 by 844; dark and System (dark here) pass.
Repro: seeded Demo, light theme, open
`#/case_manager?caseId=demo-00000539-0000&tab=runbook` (CASE-000041), run axe. The class is in
`webui/src/soc/runbooks/run/PhaseTabs.tsx` (the caption span about line 104), unchanged since
the Runbooks merge. Screenshots: `defect-response-phase-contrast-390-light.png` and
`case-runbook-1440-light.png`.

## 9. Overflow and console errors

- **Horizontal overflow**: none. On all 54 rows of the page sweep and the 12 sign-in rows,
  `scrollWidth` equals `clientWidth` (1,440 or 390), and no element reaches past the window
  outside a scrolling or clipping parent. The AI popover at 390 by 844 adds none.
- **Console**: 0 console errors, 0 page errors, 0 failed requests and 0 API answers of 400 or
  above, across every check above.

Observation, not one of the nine checks: in the case header's meta strip, the outcome badge is
clipped by its own item. At 390 by 844, CASE-000041's "True positive" badge is 104.2 px inside
a 104 px item whose content needs 182 px, so the badge loses its right border and the second
word ("Analyst") is cut without an ellipsis; at 768 px the same badge is 175.5 px in 175 px.
"Auto-closed as false positive" (CASE-000040 and CASE-000034) behaves the same. A status
(CASE-000045, "New") is not affected. Screenshot:
`observation-meta-strip-outcome-clipped-390-system.png`. The item is in
`webui/src/soc/pages/casedetail/CaseHeaderMeta.tsx` (`data-meta-item="outcome"`).

## Screenshots

In `round16/shots/WP16X/` of the build scratchpad:

- Case Manager: `cm-queue-{1440,390}-{light,dark,system}.png`,
  `case-inspector-column-nav-collapsed-1440-light.png`.
- Case page, each tab: `case-{overview,evidence,investigation,runbook,collab,chat}-{1440,390}-{light,dark,system}.png`.
- AI run: `ai-reinvestigate-dialog-1440-light.png`, `ai-chip-running-1440-light.png`,
  `ai-popover-1440-light.png`, `ai-close-dialog-warning-1440-light.png`,
  `ai-close-dialog-finished-1440-light.png`, `ai-close-dialog-ready-1440-dark.png`,
  `ai-chip-finished-1440-light.png`, `ai-inbox-notice-1440-light.png`,
  `ai-chip-running-390-{light,dark}.png`, `ai-popover-390-{light,dark}.png`.
- Risk: `risk-hover-CASE-000041-1440-light.png`, `risk-panel-CASE-000041-1440-light.png`,
  `risk-hover-CASE-000040-1440-dark.png`, `risk-panel-CASE-000040-1440-dark.png`,
  `risk-panel-CASE-000045-390-light.png`.
- Sign-in: `signin-{identity,password}-{1440,390}-{light,dark,system}.png`.
- What's new: `whats-new-page-{1440,390}-{light,dark,system}.png`,
  `whats-new-dialog-{1440,390}-{light,dark,system}.png`, and the sequence of check 4:
  `wn-A-welcome-absent-marker-1440-system.png`, `wn-B-older-marker-1440-system.png`,
  `wn-C-older-marker-1440-system-darkos.png`, `wn-P-older-marker-390-system.png`,
  `wn-E-new-account-landing-1440-system.png`.
- Help Center: `docs-0.1-redirect-chat-anchor-1440.png`.
- Findings: `defect-response-phase-contrast-390-light.png`,
  `defect-response-phase-contrast-390-light-reduced-motion.png`,
  `response-phase-tabs-1440-dark-passes.png`,
  `observation-meta-strip-outcome-clipped-390-system.png`.
