# A11Y closing sweep: receipt

Package A11Y is the closing accessibility and phone sweep of the 0.2.0 Console. It ran axe-core
on every surface the navigation opens, in light and in dark, at a desktop and a phone width. It
fixed every serious finding, each with a regression test that failed before its fix. It also
fixed the extra item from the WP17D review: Sessions & activity showed raw audit text.

## Setup

- **Tree.** `claude/round16` at `ba3fc2a` ("Journal: FXF merged; every code package is in"),
  checked out as `r16-a11y`. Release identity on screen: `v0.2.0 · Testing`.
- **Demo.** `BACKEND_PORT=8991 WEBUI_PORT=5991 DEMO_MODE=seeded ./scripts/run-demo.sh`: the
  seeded Demo with sign-in on, in-memory state, the Vite dev server and the Help Center bundle
  built by `predev`. Signed in as `Admin` / `Admin@123`. Got it was pressed on the What's new
  welcome before each page was read.
- **Browser.** Playwright 1.63.0, headless Chromium, device scale factor 2. Viewports 1440 by
  900 and 390 by 844. axe-core 4.12.1, read from the repository's `webui/node_modules` and
  injected from disk, with its default rules. Nothing was downloaded and no rule was muted. A
  finding counts when its impact is serious or critical; moderate and minor ones are listed.
- **Themes.** Light and dark are set on the account (`theme_mode`), because the account's saved
  theme overrides the browser scheme. Every row recorded whether `<html>` had the `dark` class;
  all rows matched their theme.
- **Phone checks.** At 390 by 844 every row also compared the document width with the viewport
  width and listed any element past the right edge outside a scrolling or clipping parent.
  Console errors and page errors were collected per surface at both widths.
- **Screenshots.** PNG files in the build scratchpad folder `round16/shots/A11Y/`, not in the
  repository. **Scripts.** Node scripts in the build scratchpad (`round16/a11y/`), outside the
  build: `sweep.cjs` (the sweep; `SCROLLED=1` adds the scrolled pass), `fixshots.cjs`,
  `topbar-shots.cjs` and `probe-usage.cjs` (captures and probes of each fix), and
  `summarize.py` and `summarize2.py` (the counts below).

## Surfaces

75 surfaces in each of the four combinations (light and dark, 1440 and 390):

- **The What's new welcome**, opened by an older seen marker on the landing page.
- **30 pages** the navigation opens: Overview, Dashboards, Standup, Cases, Case Manager,
  Campaigns, Logs, Chat, Investigate, Reports, Approvals, Intelligence, Knowledge, Runbooks,
  Memory, Personas, Metrics, Team activity, Agent effectiveness, Cost, Models, Baseline, Batch
  jobs, Inbox, What's new, Sources, Audit log, Auto-tuning, Settings and the Help Center.
- **31 Settings sections** (`#/settings?s=`): profile, account_security, sessions,
  customization, general, models, discounted-inference, chat_agent, detection,
  detection_rules, cases, case_policy, automation, standup, notifications, enrichment,
  knowledge, runbooks, admin_users, roles, security, admin_sessions, keys, appearance,
  release_updates, advanced, advanced_all, demo, storage, data_export and danger.
- **The case page** on an open seeded case: the six tabs (Brief, Evidence, AI investigation,
  Response, Activity, Chat), the case facts inspector, the risk Explain panel, the usage sheet,
  the close dialog, the Reinvestigate dialog, the AI run popover during a real Reinvestigate
  run, and the close dialog while that run works.

The after sweep added a scrolled pass. Each page, Settings section and case tab was scrolled
halfway, so content sat under the translucent top bar, and read again as `<surface>@scrolled`.
The before sweep did not scroll; finding 3 below shows only in that state.

## Counts

Runs with a finding, per theme and width (each run is one rule on one surface; every serious
run here had one node). The before sweep ran on the tree as received, the after sweep on this
package.

| Theme, width | Surfaces | Serious or critical, before | Serious or critical, after | Scrolled pass, after | Moderate or minor, before / after / scrolled | Sideways scroll | Console errors |
|---|---|---|---|---|---|---|---|
| Light, 1440 by 900 | 75 | 2 | 0 | 56 surfaces, 0 serious | 10 / 10 / 9 | not checked | 0 |
| Dark, 1440 by 900 | 75 | 2 | 0 | 57 surfaces, 0 serious | 10 / 10 / 9 | not checked | 0 |
| Light, 390 by 844 | 75 | 2 | 0 | 57 surfaces, 0 serious | 10 / 10 / 8 | 0 of 75 (after: 0 of 132) | 0 |
| Dark, 390 by 844 | 75 | 2 | 0 | 58 surfaces, 0 serious | 10 / 10 / 8 | 0 of 75 (after: 0 of 133) | 0 |

The two serious runs before were findings 1 and 2, in every combination. A surface gets a
scrolled read only when it has more than 40 px to scroll, so the scrolled counts differ by a
few. The theme on `<html>` matched the combination on every row. Finding 3 is not in the before
column because the before sweep did not scroll; its own capture script
(`topbar-shots.cjs`, Settings, Detection scrolled under the bar) read three nodes at 1440 and
two at 390 in light before the fix, none in dark, and none in any combination after it.

The usage-list fix was also probed directly on the seeded case with the most AI calls
(`demo-hitl-00000539-0001`, 16 calls): in all four combinations the list scrolls (1,535 px of
content in 450 px at 1440, 1,791 px in 422 px at 390), is a region named "AI calls" with
`tabindex="0"`, and axe reports no `scrollable-region-focusable` node.

## Findings and fixes

**1. A disabled number field's unit (Settings, Detection).** axe `color-contrast`, serious, one
node in all four combinations: the "min" unit of the True positive group's Objection window,
which is disabled while that auto-close is off. It measured 2.18:1 in light (#a4a9b3 on
#f5f6f9) and 2.77:1 in dark (#555e71 on #111621) for 12 px text. Target
`[data-setting-row="field"]:nth-child(3) ... [data-number-unit]`. The input's own text is
exempt as a disabled control, but the unit sits outside the input, and the whole box was faded
with `opacity-50`. No ink clears 4.5:1 at half opacity on the light ground. Fix in
`webui/src/soc/components/NumberField.tsx`: a disabled box draws from tokens instead of a fade.
It takes the muted fill (`bg-muted`, which a grouped panel re-points to `--panel-muted`), the
number takes the muted ink (`disabled:text-muted-foreground`), and the border no longer reacts
to hover. The unit now reads 5.44:1 (light) and 6.38:1 (dark) on `--muted`, and 4.94:1 and
5.82:1 on `--panel-muted`. Every disabled number field in the Console shares the change.

**2. The usage sheet's call list (case page).** axe `scrollable-region-focusable`, serious,
one node in all four combinations: the `<ol class="max-h-[50vh] ... overflow-y-auto">` of AI
calls in the usage popover scrolled, but nothing in it could take focus, so a keyboard could
not scroll it. Fix in `webui/src/soc/pages/casedetail/records/CaseUsageButton.tsx`: the list
sits in a scroll container that measures itself (on render and with a `ResizeObserver`, as
`CodeBlock` does). While it scrolls it is a region named "AI calls" with `tabIndex={0}` and
the focus ring; a short list adds no tab stop and no region.

**3. The top bar's chips over scrolled content.** axe `color-contrast`, serious, found while
capturing finding 1: with Settings, Detection scrolled under the top bar, the Demo chip's
"Demo mode", and the release badge's "v0.2.0" and "Testing", measured 4.49:1 in light
(#9b5e03 on #f5ece2), at 1440 (three nodes) and 390 (two nodes; the Demo label is hidden
there). Dark passed. The chips are wash badges (`bg-warning/10` with `text-warning-text`) on
the glass top bar, whose fill is 97% opaque, so 3% of whatever scrolls beneath shows through.
With black beneath the glass top bar, six of the seven light tints fall under 4.5:1, from
4.47:1 (info) to 4.24:1 (warning). A wash badge in a sticky header on `materialBar` or
`materialThick` falls the same way in light, and on `materialThick` the dark critical tint
falls to 4.31:1 with white beneath. Fix in `webui/src/styles/theme.css`: a material
(`.glass-surface`, `.material-surface`) re-points the seven semantic tints (`--<axis>-text`)
at the grouped panel's stronger inks (`--panel-<axis>-text`), as `.surface-panel` already
does. With black, white, the canvas or the panel beneath, the lowest ratio on any material is
now 5.31:1 in light and 4.92:1 in dark. The semantic axes are not operator-writable, so no
brand setting is overridden. The before sweep did not scroll, so its counts above do not
include this finding.

**4. Sessions & activity showed raw audit text (extra item from the WP17D review).** Under
each event name, the Activity tab printed the audit row's own summary, for example
"session_create sid=3970e7b9… new session (unknown /)" and "login ok". Fix in
`webui/src/soc/pages/Sessions.tsx`: each known account and session action shows one plain
sentence ("You signed in.", "A new session started.", "A session was renewed.", "A session was
signed out.", the two-factor and password events, "Your personal preferences changed."): the
16 sign-in, password, two-factor and session actions the Audit log's event table names, plus
personal preferences. An action the list does not know shows its event name alone. The raw
summary never shows. The lookup is an own-property check, so a name such as `toString` reads
as unknown.

No page scrolled sideways at 390 by 844, before or after, and no surface logged a console
error or a page error.

## Left as they are

Moderate and minor findings whose fix is not one safe line:

- **`empty-table-header`, minor, 7 tables** (in all four combinations): the row action
  column of Intelligence, Knowledge, Models, Settings Sessions, Users, Roles and Admin
  sessions has `header: ''`. Each needs its own short label, and a shared default in
  `DataTable` would rename columns that tests and the Columns menu read.
- **`heading-order`, moderate, 3 places**: the `AlertTitle` primitive (`webui/src/ui/alert.tsx`)
  renders an `h5`, so an alert under an `h2` skips levels. Seen on Settings, Demo Mode
  ("Isolated, free, and fully reversible"), the Reinvestigate dialog ("Costs tokens and
  overwrites the verdict") and the close dialog while the AI runs ("An AI investigation is
  running on this case."). Changing the primitive's element changes every alert's heading
  semantics and the tests that find them by role.
- **`region`, moderate, the scrolled pass only, one run per combination**: the scroll moved
  something under the resting pointer and its hover content opened in a portal outside the
  landmarks. On Overview at 1440 it was a KPI tile's trend hover card (4 nodes: "Respond ·
  daily mean", the readout, the first, peak and latest line, "11 of 14 buckets measured."),
  whose reading the tile's Explain panel also gives. On the case Evidence tab at 390 it was a
  tooltip's popper wrapper (1 node). Both are transient hover states.

Follow-up for the records package: `docs/development/ui-standard.md` ("Materials") says colour
on a material lives on solid chips. One sentence there could name the new re-point of the
semantic tints. It was not edited here because the page is part of the Help Center bundle and
its knowledge corpus, which the records package regenerates.

## Regression tests

Each test failed before its fix (the fix reverted once, the test run, the fix restored):

| Finding | Test | Before the fix |
|---|---|---|
| 1 | `webui/src/soc/components/__tests__/NumberField.disabled-contrast.test.tsx` (2 tests): reads the unit's ink token, the fill token under it and any opacity utility from the rendered classes, and composites them over the card, the canvas and a grouped panel in both themes | `light disabled unit on --card: expected 2.145 to be greater than or equal to 4.5` |
| 2 | `webui/src/soc/pages/casedetail/records/__tests__/records.a11y.test.tsx` (2 tests): a scrolling list is a region named "AI calls" with `tabindex="0"` holding the 12 calls as a list; a list that fits has no region and no tab stop | `Unable to find an accessible element with the role "region" and name "AI calls"` |
| 3 | `webui/src/design-system/__tests__/material-chip-contrast.test.ts` (4 tests): reads each wash badge's alpha and ink from `badgeVariants`, the re-point from the material rules in `theme.css`, and each material's fill (the glass top bar from its tokens, `materialBar` and `materialThick` from their recipes), and composites over black, white, the canvas and the panel in both themes | 3 failed: `light high (--high-text) on the glass top bar over black: expected 4.302 ...`, the same on `materialBar` (4.407), and `dark critical (--critical-text) on materialThick over white: expected 4.314 ...` |
| 4 | `webui/src/soc/__tests__/sessions.render.test.tsx` (1 new test, 1 updated): rows for `auth.login`, `session.created`, `session.refreshed` and `case.closed` with raw summaries show the three sentences and the event name, and none of `login ok`, `session_create`, `sid=`, `refresh_rotate` or the case summary; `activitySentence` answers null for an unknown action, `toString` and `undefined` | `Unable to find an element with the text: You signed in.` |

## Gates

Run in `webui/` on the finished package:

- `npm run typecheck`: clean.
- `npm run lint`: 0 errors, 0 warnings.
- `npm run gates`: all pass (37 tokens, contrast on 182 axes in both themes, no new arbitrary
  text size or raw hex, chart ramps separable).
- `npm run check:types`: no drift.
- The touched test files and their neighbours (the NumberField, design-system, Settings,
  Sessions, case records, design gates, phase tabs, theme tokens and Demo chip tests), with
  `--maxWorkers=2 --minWorkers=1`: 52 files, 659 tests passed.
- `npm run build:app` stamped as CI builds it (`TLSOC_RELEASE_CHANNEL=testing`,
  `TLSOC_BUILD_SHA` of 40 hex, `TLSOC_BUILD_DATE` in ISO form): 3,622 modules, no warnings. The
  entry chunk is 318,008 B against `PRE_REVAMP_ENTRY_BYTES` 330,068 B plus 1,024 B (331,092 B),
  13,084 B inside the budget and the same size as before this package.
  `bundle-first-paint.test.ts` on that build: 29 passed, 1 skipped.

As the brief says, the whole backend suite and `npm run test:strict` were not run here; the
package changes no backend file.

## Screenshots

In `round16/shots/A11Y/` of the build scratchpad, at 1440 and 390 in light and dark unless
noted:

- Before sweep: `before-whats-new-dialog`, `before-settings-detection` and the case overlays
  `before-case-{inspector,risk-explain,usage-sheet,close-dialog,reinvestigate-dialog,ai-popover,close-dialog-ai-running}`.
- After sweep: `after-whats-new-dialog` and the same case overlays as `after-case-*`.
- Finding 1: `before-fix-detection-unit-{1440,390}-light.png`, `after-fix-detection-unit-*`.
- Finding 2: `before-fix-usage-list-1440-light.png`, `after-fix-usage-list-*` and
  `after-fix-usage-list-scrolling-*` (the 16-call case with the region in view).
- Finding 3: `before-fix-topbar-chips-*` and `after-fix-topbar-chips-*` (the top bar with
  Settings, Detection scrolled beneath).
- Finding 4: `before-fix-sessions-activity-{1440,390}-light.png`,
  `after-fix-sessions-activity-*`.
