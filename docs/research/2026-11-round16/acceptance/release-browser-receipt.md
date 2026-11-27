# Release preparation: browser receipt

WP19 runs the browser acceptance of release.md §6 against the Console built exactly as a
Stable release builds it, and records what it found. It changes no product code. The harness
is Node scripts in the build scratchpad, outside the repository and outside the build.

```text
Agentic SOC browser acceptance receipt
Date (UTC):            2026-11-27 01:39 to 01:55 (sweep), second pass after it
Candidate:             v0.2.0, channel stable, SHA 963cec4335aebaa3362273de6bbb87eafbf90ea5,
                       build date 2026-11-27T01:31:04+00:00
Console /release.json: version 0.2.0, channel stable, commitSha 963cec4...0ea5,
                       buildTime 2026-11-27T01:31:04+00:00
Backend build-info:    version 0.2.0, release_channel stable, commit_sha 963cec4...0ea5,
                       build_time 2026-11-27T01:31:04+00:00, provenance_complete true
Badge:                 "v0.2.0 · Stable" ("Agentic SOC v0.2.0, Stable main build")
Served by:             vite preview over webui/dist (not nginx); backend uvicorn from
                       run-demo.sh, auth on, seeded Demo
Browser:               Chromium 153.0.8010.12 (Playwright 1.63.0), headless, scale factor 2
Viewports:             1440x900, 390x844
Themes:                Light, Dark, System(light), System(dark)
Routes swept:          71 per combination (30 pages, 31 Settings sections, 10 aliases)
                       x 2 viewports x 4 themes = 568 loads
Interaction paths:     19 checks, 19 pass (below)
Console/page errors:   0 unexplained (1 explained: the deliberate wrong password's 401)
Failed requests:       0 unexplained (the same 401)
Horizontal overflow:   0
axe serious/critical:  0
Not covered here:      nginx proxy behaviours, Release update supervisor paths, first-run
                       setup on an empty backend, SSO, browsers other than Chromium
```

## Setup

- **Build.** `npm run build` (Help Center and app) in this worktree with
  `TLSOC_RELEASE_CHANNEL=stable`, `TLSOC_BUILD_SHA=963cec4335aebaa3362273de6bbb87eafbf90ea5`
  (the release preparation commit) and `TLSOC_BUILD_DATE=2026-11-27T01:31:04+00:00`: 3,622
  modules, clean, entry chunk 318,012 B. The commit after it, which adds this receipt, changes
  only files under `docs/research/` and two backend records tests, none of which the Console,
  the Help Center bundle or the backend image's code includes, so the built product is the
  candidate's.
- **Backend.** `./scripts/run-demo.sh` with `DEMO_MODE=seeded`, `BACKEND_PORT=8995` and the
  same `TLSOC_VERSION`, channel, SHA and date (run-demo keeps a caller's stamps). In-memory
  state; its log held no traceback and no `ERROR` line for the whole run. Its Vite dev server
  was not used.
- **Server.** `BACKEND_URL=http://127.0.0.1:8995 npx vite preview --port 4995 --strictPort`
  over `webui/dist`, with the same-origin `/api` proxy.
- **Checks per load.** `pageerror`, console errors, same-origin requests that failed or
  answered 4xx or 5xx, horizontal overflow (`scrollWidth > clientWidth`), a blank main area
  (under 40 characters of text), and axe-core 4.12.1 with its default rules (a finding counts
  when its impact is serious or critical). A JPEG screenshot of every load.
- **Routes.** Generated from `backend/app/knowledge/console_map.json` (its 30 page targets and
  31 Settings sections) plus the ten compatibility aliases of `router.tsx` (`#/dashboard`,
  `#/playbooks`, `#/catalog`, `#/scans`, `#/analytics`, `#/users`, `#/security`,
  `#/sessions`, `#/account`, `#/roles`).
- **Themes.** The interaction pass switches the account theme with the real top-bar control;
  the sweep then sets the account's `theme_mode` through `PUT /api/prefs/user` for speed and
  reloads. Under System the browser's `prefers-color-scheme` was emulated light and dark.

## Identity

`/release.json` and `/api/health/build-info` both report 0.2.0, stable, the full SHA and the
build date. The top bar reads "v0.2.0 · Stable", and its popover reads "Stable main build"
with the Console build and the backend build in agreement (version, channel, commit, built).
The popover was captured in light and in dark. "Updates unavailable" shows beside it: no update
supervisor runs here.

## Interaction paths

First pass, on a fresh first sign-in (1440 by 900):

| # | Path | Result |
|---|---|---|
| 1 | Sign-in: a wrong password is refused with "The username or password is not correct." and stays on the password step | PASS |
| 2 | Sign-in: Remember me reads only "Remember me"; its warning dialog names no duration (cancelled) | PASS |
| 3 | What's new: the welcome opens on the first sign-in after the update | PASS |
| 4 | Theme: the top-bar control switches the account to light | PASS |
| 5 | What's new: after Got it and a reload the welcome does not open again | PASS |
| 6 | Communication, What's new: 0.2.0 reads "Released 27 Nov 2026" and "Installed here", not Testing | PASS |
| 7 | Case Manager: the six tabs open from their links (Brief, Evidence, AI investigation, Response, Activity, Chat) | PASS |
| 8 | Case Manager: the legacy `tab=timeline` link opens Evidence | PASS |
| 9 | Case Manager: C opens the close dialog, Escape closes it and focus returns into the page | PASS |
| 10 | Help Center: `/docs/0.2/analyst/case-manager/` serves the installed page | PASS |
| 11 | Help Center: `/docs/0.1/analyst/chat/#sources-citations-and-console-links` lands on the 0.2 page with the part after # kept | PASS |
| 12 | No page error during the pass | PASS |

Second pass, a new session after the sweep:

| # | Path | Result |
|---|---|---|
| 13 | Sign-in by keyboard (Enter on each step); the welcome stays closed once seen | PASS |
| 14 | Dashboards: the library lists the four built-in boards, the Cyber Defence Center marked Default | PASS |
| 15 | Cases: opening a row hands it to the exact Case Manager record (`#/case_manager?caseId=...`) | PASS |
| 16 | Settings: searching "auto-close" finds the section; a deep link opens one section | PASS |
| 17 | Team activity: the page opens with its People table | PASS |
| 18 | Roles & permissions: "Turn on role-based access" opens its confirm dialog by keyboard; Escape closes it and focus returns to the button | PASS |
| 19 | Navigation rail: Tab from Collapse navigation walks the rail to Sources and Enter opens it; no page error in the pass | PASS |

The first version of check 19 focused the Runbooks link by script and pressed Enter; nothing
happened, because that link sits in a collapsed rail group that is `inert`, `aria-hidden` and
`tabindex="-1"`, which is correct. The check was rewritten as a real Tab walk, which passed.

## Route sweep

| Combination | Loads | Theme as expected | Overflow | Blank | axe serious or critical | Console or page errors | Failed requests |
|---|---|---|---|---|---|---|---|
| Light, 1440 | 71 | 71 | 0 | 0 | 0 | 0 | 0 |
| Dark, 1440 | 71 | 71 | 0 | 0 | 0 | 0 | 0 |
| System (light browser), 1440 | 71 | 71 dark, see below | 0 | 0 | 0 | 0 | 0 |
| System (dark browser), 1440 | 71 | 71 | 0 | 0 | 0 | 0 | 0 |
| Light, 390 | 71 | 71 | 0 | 0 | 0 | 0 | 0 |
| Dark, 390 | 71 | 71 | 0 | 0 | 0 | 0 | 0 |
| System (light browser), 390 | 71 | 71 dark, see below | 0 | 0 | 0 | 0 | 0 |
| System (dark browser), 390 | 71 | 71 | 0 | 0 | 0 | 0 | 0 |

- **System on a light browser reads dark.** The seeded Demo's organization default theme is
  dark (`/api/branding` `default_theme: dark`), and under System the organization default wins
  over the browser scheme (`resolveDark` in `webui/src/soc/theme-tokens.ts`), as WP16X also
  recorded. Every one of the 142 loads rendered dark, consistently. This is the designed
  precedence, not a defect.
- **Below serious.** On each combination axe reported `empty-table-header` (minor) on 10 routes
  (the `intelligence`, `knowledge` and `models` pages, the `sessions`, `admin_users`, `roles`
  and `admin_sessions` Settings sections, and the `#/users`, `#/sessions` and `#/roles`
  aliases) and `heading-order` (moderate) on the `demo` Settings section. Both are already recorded as left by
  the A11Y closing sweep.

## Screenshots

580 files in the build scratchpad folder `round16/shots/WP19/`, not in the repository: the 568
sweep loads as JPEG (named `<theme>-<width>-<kind>-<route>`), the 8 PNG captures of the first
pass (sign-in steps, the Remember me dialog, the welcome, the What's new page, the close
dialog, the identity popover in light and dark) and the 4 PNG captures of the second pass. The
System (light browser) captures are named `system-schemelight-dark-...` because they show
dark. A luminance check of each image's top band against the theme its name states found 0 of
580 mismatched. Spot checks: the identity popover in both themes and the Case Manager brief at
390 in light.

## Not covered here

- **The nginx proxy** (`webui/nginx.conf`): unbuffered server-sent events, the 3 MiB
  screenshot body bound, `index.html` no-store and immutable `/assets/` caching, the security
  headers. `vite preview` is not a production server.
- **The Release update supervisor**: signed preflight, supervisor states and the automatic
  rollback; only the badge and "Updates unavailable" are visible without it. These and the
  canonical bootstrap stay maintainer action M5.
- **SSO** (no identity provider), Firefox and Safari (only Chromium is installed). The
  first-run setup on an empty backend was opened in the review pass below; creating the first
  account through it was not.
- **Interaction paths of release.md §6.3 step 5 not repeated here**: the Overview drill-downs,
  an Edit-mode board, the queue divider resize and its reset, the bulk menu, case screenshots
  (add, paste, view, delete), the auto-close review, a runbook run with its Next step card,
  the Team activity person sheet, and the RBAC switch carried through. The product code is the
  same as the integrated tree that WP16X and the A11Y closing sweep exercised on the Vite dev
  server; this receipt does not repeat their claims.

## Result

The stamped Stable build identifies itself consistently in the Console and the backend, and
the 568 loads and 19 interaction checks found no unexplained error, failed request, overflow,
blank page or serious accessibility finding.

## Review pass

The review commit `f6a1fe52cdf797d7325ffbdf4f6a3309a3f7c51f` changes Help Center pages, the
release page and the knowledge corpus, so the built product is no longer the one swept above.
No Console source and no Console data changed. The review rebuilt the Console stamped the same
way and ran a focused pass on it; the sweep above was not repeated.

```text
Date (UTC):            2026-11-27 02:31
Candidate:             v0.2.0, channel stable, SHA f6a1fe52cdf797d7325ffbdf4f6a3309a3f7c51f,
                       build date 2026-11-27T02:23:29+00:00
Build:                 npm run build, 3,622 modules, entry chunk 318,012 B; docs:check with
                       the same stamps passes
Served by:             vite preview on port 6095 over webui/dist, against run-demo.sh on port
                       9095 (seeded Demo, auth on); a second vite preview on port 6096 against
                       an empty backend on port 9096 (auth on, no seeded account)
Browser:               Chromium (Playwright 1.63.0), headless, scale factor 2
Checks:                19 checks, 19 pass
```

| # | Check | Result |
|---|---|---|
| 1 | `/release.json` and `/api/health/build-info` both report 0.2.0, stable, the review SHA and the same build time | PASS |
| 2 | The What's new welcome opens on the first sign-in after the update (sign-in by Enter on each step) | PASS |
| 3 | Focus starts inside the welcome and twelve presses of Tab stay inside it | PASS |
| 4 | axe finds nothing serious or critical with the welcome open | PASS |
| 5 | Escape closes the welcome and focus returns to the page | PASS |
| 6 | After a reload the welcome stays closed | PASS |
| 7 to 10 | The What's new page in light and dark at 1440 by 900 and 390 by 844: 0.2.0 reads "Released 27 Nov 2026" and "Installed here", no overflow, nothing serious or critical in axe | PASS |
| 11 | At 390 in dark, "Show the welcome screen" opens the welcome by keyboard, and Escape returns focus to that button | PASS |
| 12 to 16 | The installed Help Center serves the corrected pages: the release page (its test counts and its Rollback section), the install page, the audit id column pre-step in Upgrade operations, and the topology note in Release channels | PASS |
| 17 | The empty backend opens "Create your admin account", not the sign-in, with nothing serious or critical in axe | PASS |
| 18 | No page error on the empty backend | PASS |
| 19 | No page error, console error or failed request on the seeded Demo pass | PASS |

Screenshots are in the build scratchpad folder `round16/shots/WP19-review/`, not in the
repository. Every server the pass started was stopped afterwards.
