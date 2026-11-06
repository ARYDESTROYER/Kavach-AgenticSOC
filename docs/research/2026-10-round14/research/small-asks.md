# Round 14 research: the small asks (1, 4 and 5)

Research brief for the Round 14 orchestrator. Research only: nothing in the product was
changed. Branch `claude/round14` at `a966b0d`. Measurements and screenshots come from the
shared Demo Mode console (web UI on port 5901, Admin, live synthetic data) on 2026-10-25.

| Ask | Operator words (short) | Recommendation in one line |
|---|---|---|
| 1 | Do not tell the user the duration on auto sign-out | One neutral sentence per reason, no duration anywhere after the fact; keep the duration only where the user chooses it (Remember me) and in admin settings |
| 4 | Remove the "Alert flow" and "Cases and response" band headers, reclaim space | Delete both band headers, tighten the module rhythm to the panel gutter, move the two facts the captions carried into the cards, keep one honest "Updated" stamp |
| 5 | Triple every value under Chat assistant, Timeouts and capacity, and make it the default | 4 to 12, 15 s to 45 s, 300 s to 900 s, 4 to 12, 16 to 48; raise two max bounds (three recommended); a one-time `chat_limits_version` 2 migration moves only values still at the old default |

Screenshot index (all absolute paths, all under the session scratchpad):

- Ask 1: `<scratch>/r14/shots/research/signout-current-absolute-light.png` (today, "after 12 hours"), `.../signout-proposed-absolute-light.png` (option 1A), `.../signout-proposedB-absolute-light.png` (option 1B), `.../signout-current-idle-light.png` (idle, unchanged), each also as `-dark.png`.
- Ask 4: `.../overview-annotated-1440x900-light-full.png` and `.../overview-annotated-1920x1080-light-full.png` (the two headers outlined in red), `.../overview-current-*`, `.../overview-optA-*`, `.../overview-optB-*` (recommended), `.../overview-optC-*` at `1440x900-light` and `1920x1080-light` (viewport and `-full` page), `.../overview-optB-1920x1080-dark*.png`, and `.../overview-{current,optB}-390x844-light*.png`. Each has a `.json` with the raw measurements.
- Ask 5: `.../chatcap-current-1440.png` (today) and `.../chatcap-tripled-preview-1440.png` (tripled values painted into the inputs for the picture only; nothing was saved).

(`...` = `<scratch>/r14/shots/research`.)

The scripts that produced them are in
`<scratch>/r14/notes/`
(`ov-measure.mjs <WxH> <theme> <current|annotated|optA|optB|optC>`, `signout-shot.mjs`,
`signout-shotB.mjs`, `chatcap-shot.mjs`). Options are injected as CSS or text in the
browser only; they are previews, not implementations.

---

## Ask 1: the automatic sign-out notice must not state a duration

### 1.1 What the operator saw

"For your security, you were signed out after 12 hours. Sign in to continue." The 12 hours
is the ordinary (not remembered) session: `AUTH_TOKEN_HOURS` defaults to 12
(`docs/administration/authentication.md:43-45`), and when the JWT runs out the public
`GET /api/auth/me` reports `reason: absolute_expired` with
`lifetime_seconds = exp - iat` (`backend/app/api/routes.py:3570-3580`). Reproduced in the
demo by answering `/api/auth/me` with that shape: the notice reads exactly the operator's
sentence (screenshot `signout-current-absolute-light.png`).

### 1.2 Where the notice is worded (code map)

| Place | What it does |
|---|---|
| `webui/src/soc/components/auth/rememberMe.ts:183-201` `signedOutNotice(reason, lifetimeSeconds)` | The ONE wording table. `absolute_expired` with a lifetime: "For your security, you were signed out after ${formatRememberDuration(lifetimeSeconds)}. Sign in to continue." (`:189-190`); without one: "For your security, your session ended. Sign in to continue." (`:191`); `idle_expired`: "...after a period of inactivity. Sign in to continue." (`:193`); `revoked`: "This session was ended from another device or by an administrator. Sign in to continue." (`:195`); `tv_mismatch`: "All of your sessions were signed out. Sign in to continue." (`:197`); anything else: no notice (`:198-199`). |
| `rememberMe.ts:137-155` `takeExpiredRememberedSession()` | A remembered session that ran out while the browser was closed (the browser dropped the cookie, so only the device knows): reads the `soc.login.rememberedUntil` marker `{until, lifetime}` once and returns `{lifetimeSeconds}`. |
| `rememberMe.ts:94-115` `recordSignIn()` and `:276-297` `afterSignIn()` | Write that marker after a remembered sign-in, including `lifetime` (fed from `Login.tsx:459-466`, `rememberStatus.duration_seconds`). |
| `webui/src/soc/components/auth/RememberMeControls.tsx:211-262` `SessionEndNotice` | Renders the notice in a polite live region on the sign-in page and links the focused field to it with `aria-describedby` (`SESSION_END_NOTICE_ID`). Passes `lifetimeSeconds` through (`:240-248`). |
| `webui/src/soc/auth.tsx:28-34, 173-179` | `SessionEnded {reason, lifetimeSeconds, remembered}` built from `/auth/me` (`me.lifetime_seconds`). Comment at `:163` quotes "you were signed out after 24 hours". |
| `webui/src/soc/pages/Login.tsx:809-813` | Mounts `SessionEndNotice` with `endedSession.reason` and `.lifetimeSeconds`. |
| `webui/src/lib/types.ts:51-56, 74-83` | `SessionEndReason` (open string union) and `AuthMe.lifetime_seconds` ("86400 → after 24 hours"). |
| `backend/app/api/routes.py:3532-3600` `auth_me` / `_ended()` | Emits `reason`, `lifetime_seconds` (absolute: JWT `exp - iat` or the registry's absolute limit; idle: the idle limit) and `remembered`. Comment `:3574` quotes "signed out after 24 hours". |
| `backend/app/auth/tokens.py:77` | Docstring quotes the same sentence (explains `verify_exp=False`). |

Other session-end and sign-out copy (none of it states a duration today, none needs to change):

| Place | Copy |
|---|---|
| `webui/src/lib/api.ts:608` | `session_invalid`: "Your session is no longer valid. Please sign in again." |
| `webui/src/soc/pages/Login.tsx:676` | "Your setup session expired. Sign in again to continue setting up two-factor authentication." |
| `backend/app/api/routes_chat.py:237` | Chat turn stopped: "Your session ended, so this answer was stopped before it finished. Sign in again to ask." |
| `webui/src/soc/pages/Sessions.tsx:500, 516, 634-635, 666` | Deliberate sign-outs ("Signed out this device.", "Signed out all other sessions.", confirmations). A deliberate sign-out already clears the expiry marker (`auth.tsx:160-164`, `Sessions.tsx:497`), so it never shows the notice. |

There is no "you will be signed out soon" warning anywhere in the console today.

### 1.3 Is `formatRememberDuration` (or the lifetime) still needed after the change?

Yes, the function stays; only the after-the-fact use goes:

- `RememberMeControls.tsx:56-61` `rememberIdleLimit()` and `:83-91` the Remember me hint
  "Stay signed in on this device for up to 24 hours" (and the warning dialog's window
  phrase via `formatRememberWindow`, `rememberMe.ts:173-177`). This is a disclosure BEFORE
  the user opts in, which is exactly where WCAG 2.2.6 wants a duration (see 1.4).
- `webui/src/soc/components/SessionPolicyEditor.tsx:338, 359, 628`: the administrator's
  session policy editor. Admins need durations.

The `lifetime` half of the device marker and the `lifetimeSeconds` plumbing
(`auth.tsx`, `Login.tsx:464`, `SessionEndNotice` prop, `signedOutNotice` second argument)
become dead and should be removed. The marker keeps `until` (it still tells the sign-in
page that a remembered session ended while the browser was closed); `takeExpiredRememberedSession`
should keep tolerating an old `{until, lifetime}` marker written by the previous build and
simply ignore `lifetime`.

### 1.4 What the standards say

- OWASP Session Management Cheat Sheet: every session needs idle and absolute timeouts
  enforced server side; after an inactivity logout "the user can see that the session has
  finished due to inactivity". It gives no wording and never asks for the duration to be
  shown after the fact. https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- HMRC design patterns, Service timeout (the GOV.UK family pattern most services copy):
  the signed-out page heading is "For your security, we signed you out", with no duration.
  The only time reference is in the warning BEFORE sign-out ("For your security, we will
  sign you out in 2 minutes.", with Stay signed in / Sign out).
  https://design.tax.service.gov.uk/hmrc-design-patterns/service-timeout
- DWP Design System, Manage a session timeout: the timeout page "explains that the user
  has been signed out and will need to sign in again"; warn at least 2 minutes before.
  https://design-system.dwp.gov.uk/patterns/manage-a-session-timeout and
  https://design-system.dwp.gov.uk/patterns/manage-a-session-timeout/examples/timedout-signedin
- WCAG 2.2 SC 2.2.6 Timeouts (AAA): users are warned of the duration of inactivity that
  could cause data loss, and "Timeouts should be displayed to the user once at the beginning
  of the related task or process and not at each step." So the duration belongs at the
  start (our Remember me hint), not on the sign-in page afterwards.
  https://www.w3.org/WAI/WCAG22/Understanding/timeouts.html
- NIST SP 800-63B-4 section 5.2: when either timeout expires the session SHALL be
  terminated; the RP MAY alert the subscriber before termination. Nothing about announcing
  the length afterwards. https://pages.nist.gov/800-63-4/sp800-63b/session

Security angle: `/auth/me` is public. Saying "after 12 hours" on a shared screen also
tells a bystander the policy; nothing in the sign-in task needs it. The operator's ask and
the guidance agree.

### 1.5 Recommendation: exact wording per reason

Option 1A (recommended, smallest change, keeps the established voice and the explicit
call to action):

| Reason | Today | Proposed |
|---|---|---|
| `absolute_expired` (any lifetime, standard or remembered, server or device marker) | "For your security, you were signed out after 12 hours. Sign in to continue." / "For your security, your session ended. Sign in to continue." | "For your security, you were signed out. Sign in to continue." |
| `idle_expired` | "For your security, you were signed out after a period of inactivity. Sign in to continue." | unchanged (a reason, not a duration; OWASP explicitly wants inactivity to be visible) |
| `revoked` | "This session was ended from another device or by an administrator. Sign in to continue." | unchanged |
| `tv_mismatch` (sign out everywhere, password change) | "All of your sessions were signed out. Sign in to continue." | unchanged |
| any other non-empty reason (the union is open, `types.ts:51-56`) | no notice | "For your security, you were signed out. Sign in to continue." (so a future server reason is never silent) |

Screenshot: `signout-proposed-absolute-light.png` / `-dark.png`.

Option 1B (shorter): the sign-in card's own subtitle already says "Sign in to continue to
Agentic SOC.", so the notice repeats the call to action. 1B drops the trailing "Sign in to
continue." from all four sentences, e.g. "For your security, you were signed out." (HMRC's
heading, in our passive voice). Screenshot: `signout-proposedB-absolute-light.png`. Cleaner,
but it touches every reason and every test that pins them; recommend 1A now, 1B only if
the operator prefers it.

Do not change: the Remember me hint "Stay signed in on this device for up to 24 hours"
and its warning dialog (consent disclosure before the fact, WCAG 2.2.6), and the
Session policy editor (admin configuration).

### 1.6 The `lifetime_seconds` wire field

Two choices:

- Keep emitting it (recommended for this round): no API change (AGENTS.md treats only
  ADDITIVE changes as safe), `backend/tests/test_remember_me.py:974, 984` stay green; the
  console simply stops reading it. Document in `docs/reference/api.md:94-97` that the
  console does not show it.
- Stop emitting it: it would have no consumer left, and the endpoint is public. A removal
  is a contract change, so it needs its own decision and the two backend assertions
  updated. Open question for the operator.

### 1.7 Files, tests and docs to touch

- Code: `rememberMe.ts` (`signedOutNotice` drops the second parameter and the duration
  branch; marker writes `{until}` only; header comment `:15-17`), `RememberMeControls.tsx`
  (`SessionEndNoticeProps.lifetimeSeconds` and its use), `auth.tsx` (`SessionEnded.lifetimeSeconds`,
  comment `:163`), `Login.tsx:464, 811`, `types.ts:74-78` comment, comment-only
  `routes.py:3574` and `tokens.py:77`.
- Tests: `webui/src/soc/__tests__/login.remember.test.tsx:761-799` (the two
  `absolute_expired` rows with 86,400 and 21,600 seconds now expect the neutral sentence;
  the "ran out while the browser was closed" test `:782-799` expects it too). Add a
  regression that no notice for any reason and any lifetime contains a digit or the words
  hour/minute/day. `auth.remember.test.tsx:200-215` (idle) stays as is.
- Docs: `docs/administration/authentication.md:45-48` already says "after the time limit"
  in general terms; reword to "the sign-in page says why (inactivity, the session's time
  limit, ended from another device or by an administrator, or all sessions signed out),
  without stating how long the session lasted". Regenerate the Help Center corpus
  (`backend/app/knowledge/app_docs.json`). CHANGELOG `[Unreleased]`.

---

## Ask 4: remove the "Alert flow" and "Cases and response" band headers

### 4.1 How the bands are built today

- `Band` (`webui/src/soc/pages/Overview.tsx:1576-1614`): a `<section aria-labelledby={id}>`
  with a `<header class="mb-4 ...">` holding an `<h2>` (15px, `text-md font-semibold`), an
  optional 13px caption `<p>`, and an optional right-hand aside. No card, no rule.
- Used twice inside the `hero-row` group (`Overview.tsx:3874-3881`, `space-y-10 3xl:space-y-12`):
  - `overview-band-flow` (`:3882-3891`): title "Alert flow"; caption "How the last 24 hours
    of alerts became cases (the N in Total Cases above), and who closed them" (the
    parenthesis only when `crossRefs.flowCases` equals the Total Cases tile,
    `:3255-3285`); aside `<Freshness at={noise.generated_at}>`.
  - `overview-band-cases` (`:3984-3989`): title "Cases and response"; caption "Cases that
    arrived in the last 24 hours · response timing is p50, computed on the server"; aside
    `<Freshness at={posture.generated_at}>`.
- `Freshness` (`:1481-1507`) is the "Updated just now" stamp. The page header already
  shows one (`:3653-3659`), computed as the NEWEST of the case batch and the posture
  rollup (`:3611-3614`). The Round 12 comment at `:1491-1494` explains the per-band stamps:
  the slices load independently, so one global stamp could claim freshness some do not
  have.
- Spacing: `overview-modules` group `space-y-10` (40px) from the KPI strip to the bands
  (`:3703`); 40px between bands (48px from 1920px); 40px to Deeper analytics. The page
  container itself is `space-y-8 3xl:space-y-10` (`:3567`).

Every module under the bands already carries its own visible title, and all of them are
already `h2`, siblings of the band `h2`s rather than children:
"Noise reduction flow" (`webui/src/soc/components/NoiseFunnel.tsx:1554-1563`),
"Human vs AI" (`webui/src/soc/components/HumanVsAiCard.tsx:264`), "Open cases" and
"Cases resolved" (`SnapshotCard`, `Overview.tsx:885`), "Response time" with the subtitle
"p50 · server-computed" (`:4116-4117`), and "Latest cases" with "Real-time triage queue"
(`:1115-1116`).

### 4.2 Measured space (shared demo, light theme, navigation pinned)

| Viewport | Each band header | Both headers | Page height today | Option A | Option B (recommended) | Option C |
|---|---|---|---|---|---|---|
| 1440 x 900 | 40px + 16px margin = 56px | 112px | 1,521px | 1,409 (-112) | 1,349 (-172) | 1,361 (-160) |
| 1920 x 1080 | 56px | 112px | 1,726px | 1,614 (-112) | 1,558 (-168) | 1,582 (-144) |
| 390 x 844 | 80px + 16px (caption wraps) | 192px | 3,550px | (not run) | 3,286 (-264) | (not run) |

At 1440 x 900 the second row (Open cases, Response time, Latest cases) starts at 929px
today, below the 900px fold; with option B its panels start at 777px, so the titles and
the top of every card in that row are on the first screen.

### 4.3 Options (screenshots)

- Option A: remove both headers, keep the 40px / 48px rhythm.
  `overview-optA-1440x900-light-full.png`, `overview-optA-1920x1080-light-full.png`.
- Option B (recommended): remove both headers AND set the gaps between the KPI strip, the
  flow row, the cases row and the Deeper analytics header to the panel gutter (16px, 20px
  from 1280px, 24px from 1920px). The whole dashboard then reads as one grid of panels,
  the same rule ui-standard already applies between panels ("Panel padding and the gutters
  between panels grow together"), and the way Microsoft Sentinel workbooks, Datadog and
  Grafana dashboards tile panels without section headers.
  `overview-optB-1440x900-light-full.png`, `overview-optB-1920x1080-light-full.png`,
  `overview-optB-1920x1080-dark.png`, `overview-optB-390x844-light-full.png`.
- Option C: remove both headers, 24px rhythm (32px from 1920px): a little more air
  between rows than between cards in a row. `overview-optC-*`.

The "before" with the two headers outlined: `overview-annotated-1440x900-light-full.png`.
The masthead to KPI strip gap (32px, 40px from 1920px) is untouched in every option; it
could also drop to 24px later if the operator wants more, but it was not asked.

### 4.4 Information the band captions carried, and where it goes

| Caption fragment | Already said elsewhere? | Move |
|---|---|---|
| "How the last 24 hours of alerts became cases" | Partly: the flow's own footer says "N open cases from this window" | Add the window as a caption next to the flow title, like every Deeper analytics instrument ("Noise reduction flow · last 24 hours"), so the panel stays self-explanatory when the masthead picker is scrolled away on a phone |
| "(the N in Total Cases above)" | No | Move into the flow panel as a quiet footer line, exactly the Human vs AI pattern ("AI agent is the same count as Auto Closed above.", `HumanVsAiCard.tsx:136, 385-387`): "Cases opened is the same count as Total Cases above." Shown only when `crossRefs.flowCases` holds (same equality rule). Needs a `crossReference` prop on `NoiseFunnel` (flat variant) |
| "and who closed them" | Yes: the Human vs AI title and its help tip | Nothing |
| "Cases that arrived in the last 24 hours" | Yes for the two snapshots ("Arrived in the last 24 hours, still open / now resolved or closed") | Response time: subtitle "p50 · last 24 hours · server-computed" (or keep "p50 · server-computed" and rely on the masthead); Latest cases is the window's newest cases, so "Newest of the last 24 hours" is more accurate than "Real-time triage queue" (optional wording fix) |
| "response timing is p50, computed on the server" | Yes: Response time already says "p50 · server-computed" (`:4117`) | Nothing |
| "Updated just now" (twice) | The page header stamp | See 4.5 |

### 4.5 One "Updated" stamp that never overclaims

Keep only the page header stamp, but compute it as the OLDEST of the independently loaded
slices that feed the visible modules (case batch `loadedAt`, `posture.generated_at`,
`noise.generated_at`) instead of the newest (`Overview.tsx:3611-3614`). That keeps the
Round 12 honesty rule (no stamp claims a freshness some slice does not have) with one
stamp. A slice whose refresh failed already says so inside its own card (the flow's
"Refresh failed. Showing the last loaded flow.", Human vs AI's `stale`), so nothing is
lost. Optional: a tooltip on the stamp listing each slice's time.

### 4.6 Accessible structure

No visually hidden headings are needed. Without the band `h2`s the outline becomes
h1 "Cyber Defence Center", then h2 per module in reading order (Noise reduction flow,
Human vs AI, Open cases, Cases resolved, Response time, Latest cases, Deeper analytics),
which is flatter and more correct than today (module `h2`s currently sit beside the band
`h2`s, not under them). Region landmarks: the two `section[aria-labelledby]` band regions
go away; most modules are already their own labelled sections ("Human vs AI", "Resolved
and open cases", "Mean time to detect / respond", "Latest cases"). The flow panel is a
plain `div`; wrap it as `<section aria-labelledby>` pointing at the funnel's `h2` (give it
an id) so every module is a region. Replace each `Band` with a plain `div` carrying a
stable hook (`data-band="flow"` / `data-band="cases"`) for tests and print CSS; delete
`Band`. Keep `cases-band-container` / `cases-band-grid` test ids.

### 4.7 What else depends on the headers (all must change together)

- Print CSS: `webui/src/styles/theme.css:1896-1901` targets
  `#socMain [aria-labelledby='overview-band-flow'] > div`; retarget to the new hook.
  Pinned by `webui/src/soc/__tests__/overview.print.test.ts:68-72`.
- DOM inventory test: `webui/src/soc/__tests__/overview.inventory.test.tsx:265-268`
  (region "Alert flow", caption text, freshness), `:365-368` (region "Cases and response",
  freshness), `:596-604` and `:625-630` (cross-reference caption with and without the
  count; move these assertions to the new flow footer line). Page stamp `:226` stays.
- Panels test: `webui/src/soc/pages/__tests__/overview-panels.test.tsx:555` (flow grid
  found through the region) and `:561-570` ("keeps band titles outside the panels") become
  "no band titles; every module title is inside its panel".
- Docs: `docs/development/ui-standard.md:1083-1095` "Dashboard bands" (titled bands,
  band titles on the canvas, "bands sit 40px under the KPI strip and 40px apart"):
  rewrite as "modules on grouped panels, one gutter apart, no section titles";
  `docs/analyst/overview.md:54-65` ("Read the two bands"); `docs/USAGE.md:119-125`;
  the file header comment `Overview.tsx:18-25` and the band comment `:3862-3881`;
  regenerate `backend/app/knowledge/app_docs.json`; CHANGELOG `[Unreleased]`.
- 4xl (2200px and wider): both rows use the shared track template with the 460px rail;
  removing the header does not change the grids.

---

## Ask 5: triple the Chat assistant "Timeouts and capacity" values

### 5.1 The five knobs

All live in `ChatAgentConfig` (`backend/app/config.py:1602-1724`), apply in both limits
modes, and are edited in `webui/src/soc/pages/settings/chat-agent.tsx:300-312`
(`CAPACITY_LIMITS`, behind "Show timeouts and capacity", `:502-511`).

| UI label | Key | Default today | New default | Range today (`ge`, `le`) | Fits? | Recommended range | Enforced at |
|---|---|---|---|---|---|---|---|
| Lookups at once | `max_parallel` | 4 | 12 | 1 to 8 (`config.py:1644-1646`) | No | 1 to 24 | Unlimited mode: per-step semaphore `backend/app/agents/chat.py:2822`; Bounded: lookups past position `max_parallel` are skipped `:2776`; `effective_parallel` `config.py:1819-1828` (Bounded: never above `max_tool_calls`); prompt "at most {max_parallel}" `agents/prompts.py:795, 961, 986` via `routes_chat.py:2761` and `chat.py:1673` |
| Lookup timeout | `tool_timeout_s` | 15 s | 45 s | 1 to 120 (`:1647-1650`) | Yes | 1 to 120 (unchanged) | `agents/chat_tools/registry.py:326-331` (aggregate tools keep their own 600 s budget, never below this, `:73, 529-539`); `chat_tools/logs.py:458`; `chat.py:3055, 3451` |
| Model call timeout | `model_step_timeout_s` | 300 s | 900 s | 5 to 900 (`:1651-1656`) | Only at the ceiling | 5 to 1,800 | Stall timer: silence while streaming, total time for blocking providers `chat.py:2585-2626`; Bounded: `min(step, time left)` `:2373-2379`; report AI summary `routes_reports.py:131-133, 1705-1706` |
| Questions at once per user | `max_concurrent_turns_per_user` | 4 | 12 | 1 to 10 (`:1677-1679`) | No | 1 to 24 | `routes_chat.py:1702-1712` (`registry.acquire`, 429 `chat_busy`) |
| Questions at once in total | `max_concurrent_turns_global` | 16 | 48 | 1 to 100 (`:1680-1682`) | Yes | 1 to 100 (unchanged) | same |

Screenshots: `chatcap-current-1440.png` (4, 15, 300, 4, 16) and
`chatcap-tripled-preview-1440.png` (12, 45, 900, 12, 48).

### 5.2 Must the max bounds rise?

- `max_parallel` (8) and `max_concurrent_turns_per_user` (10) MUST rise: the new
  defaults are above them, and `_repair` (`config.py:1727-1812`) would clamp a default of
  12 down. 24 keeps the old "about twice the default" headroom.
- `model_step_timeout_s` should rise: 900 is exactly today's ceiling, so the stepper's
  plus button would be disabled at the default and an operator could not lengthen it.
  1,800 s still fits inside the hidden runaway fuse (60 minutes per question,
  `chat.py:247-248`): one stall of 1,800 s plus its one retry is 3,600 s.
- `tool_timeout_s` (120) and `max_concurrent_turns_global` (100) can stay.

The UI copies of the bounds are pinned to `config.py` by a test
(`webui/src/soc/pages/settings/chat-agent.tsx:126-141`,
`__tests__/chat-agent.test.tsx:98-104`), so both move together.

### 5.3 Migration: only values still at the old default move

Pattern to reuse: Round 12's one-time `chat_limits_version` migration
(`config.py:1532-1599`): `CURRENT_CHAT_LIMITS_VERSION = 1`; `_CHAT_CHANGED_DEFAULTS`
moved `model_step_timeout_s` 30 to 300, per user 2 to 4, global 8 to 16; only in persisted
blocks (`_CHAT_PERSISTED_MARKERS`, so `ChatAgentConfig(model_step_timeout_s=30)` in code
keeps 30); a block at the current version is never re-decided.

Why a migration is needed at all: a deployment whose administrator ever saved Settings
(the operator's own) has the whole `chat_agent` block stored with 4 / 15 / 300 / 4 / 16.
New field defaults alone would only reach fresh installs, so "Default it" would not
happen where the operator looks.

Proposed shape (version 2):

1. `CURRENT_CHAT_LIMITS_VERSION = 2`; the `chat_limits_version` field `le` follows it.
2. Make `_migrate_chat_limits` staged instead of "return early at the current version":
   run the existing version-1 step when the stored version is below 1, then a new
   version-2 step when it is below 2, then stamp 2.
3. Version-2 step, persisted blocks only: for each of
   `max_parallel (4 → 12)`, `tool_timeout_s (15 → 45)`, `model_step_timeout_s (300 → 900)`,
   `max_concurrent_turns_per_user (4 → 12)`, `max_concurrent_turns_global (16 → 48)`,
   move the value only if it equals the old default. Any other value is an operator choice
   and stays.
4. Chaining is correct for very old blocks: a pre-Round-12 block (2 / 8 / 30) becomes
   4 / 16 / 300 in step 1 and 12 / 48 / 900 in step 2. A Bounded block that kept 30 s in
   Round 12 stays at 30 s (30 is not 300).
5. `model_step_timeout_s` in Bounded mode: Round 12 skipped it for Bounded blocks. For
   version 2 it is safe to move it in both modes, because Bounded already caps a call at the
   question's remaining time (`chat.py:2373-2379`, 90 s by default). Recommend moving in
   both modes; the conservative alternative is to mirror Round 12 and skip Bounded.

Known limitation (same as Round 12, document it): an administrator who deliberately
chose exactly 4 / 15 / 300 / 4 / 16 cannot be told apart from the default and is moved.
The UI round-trips `chat_limits_version` (`coherentChatAgent` spreads the stored block,
`chat-agent.tsx:171-185`), so a value set after the migration is never moved again.

Tests to add next to `backend/tests/test_chat_limits_migration.py`: a version-1 stored block
at the Round 12 defaults moves to the tripled values; a version-1 block with any one
changed value keeps that value and moves the rest; a pre-Round-12 block chains to the new
values; a programmatic construction is untouched; the migration runs once.

### 5.4 Knock-on effects

- Bounded mode shows 10, not 12: `effective_parallel` is `min(max_parallel, max_tool_calls)`
  and `max_tool_calls` defaults to 10 (`config.py:1641-1643, 1819-1828`); the editor
  displays the effective value (`chat-agent.tsx:357-367`). Expected and already documented.
- Load on log sources: one question may now run 12 lookups at once and 48 questions may
  run at once: up to 576 concurrent read queries in the worst case (each log lookup can fan
  out to every browse-capable source with per-source timeouts). Elasticsearch's search
  thread pool is `int(processors * 3 / 2) + 1` threads with a queue of 1,000
  (13 threads on 8 vCPUs), so a burst queues rather than fails, but slows other readers.
  https://www.elastic.co/guide/en/elasticsearch/reference/8.19/modules-threadpool.html.
  The per-reply cap of 40 lookups (`chat.py:251-255`) is unchanged.
- Model provider rate limits: within one question model calls are sequential, so 48
  questions means at most 48 calls in flight. Anthropic's Start tier allows 1,000 RPM,
  2,000,000 uncached input tokens and 400,000 output tokens per minute for current models
  (https://platform.claude.com/docs/en/api/rate-limits); 48 busy questions each sending
  30,000 to 60,000 input tokens per step can exceed the input-token limit on low tiers
  (cached prompt reads do not count). 429s are retried (`llm/providers.py` `with_retry`);
  a 429 that exhausts the retry budget is classified `quota`, an immediate-trip class
  for the provider circuit breaker (`llm/gateway.py:249-259`). The breaker is advisory by
  default (`enforce` off, `config.py:1916-1917`); if an operator enforces it, a chat burst
  could pause investigations too. Worth one sentence in the settings hint or the Help
  Center.
- Memory per question: each running question keeps an event ring of at most 2,000 entries,
  1,000,000 text characters and 250,000 delta markers (roughly 2 to 5 MB worst case,
  `routes_chat.py:174-194`), and finished questions stay readable for 300 s (at most 256).
  Worst case moves from about 80 MB (16) to about 240 MB (48) per backend process; typical
  answers are tens of KB. Concurrency is process-local (AGENTS.md), so 48 is per process.
- Lease timing: the Workspace reservation lease is 600 s, renewed every 60 s by a
  separate heartbeat task (`routes_chat.py:163-168, 1173-1206`), so a 900 s model call does
  not let the lease lapse. No change needed.
- Stall detection: tripling means a stream that stays connected but produces no text
  waits 15 minutes before its one retry (30 minutes worst case for one step). The provider
  HTTP clients' own read timeouts (60 s; 600 s on OpenAI Flex,
  `llm/providers.py:631, 796, 1517, 1622`) still end a connection that sends nothing at
  all, and Stop always abandons the call at once.
- Report AI summary: its timeout is 2 x `model_step_timeout_s` (`routes_reports.py:131-133,
  1705-1706`): 600 s today, 1,800 s after tripling, while the Web UI proxy gives
  `/api/` 300 s (`webui/nginx.conf:58-68`). The mismatch already exists (600 > 300) and
  tripling widens it. Recommend capping the summary wait independently (for example
  `min(2 x step, 280 s)`) or giving the summary route its own proxy block; flag as a
  separate fix.
- Client copy: no Console string states 300 s or the concurrency numbers. The client
  fallback `DEFAULT_CHAT_BOUNDS` (`webui/src/soc/chat/chat-api.ts:213-227`) already carries
  a stale `model_step_timeout_s: 30` and `max_parallel: 4`; update it to the new defaults.
  The client busy wait (`turn-runner.ts:236`, 5 minutes before Retry) is not one of these
  knobs; leave it (open question).
- Demo planner: `engine/demo_chat.py:600` parses the prompt's "at most N" and clamps to 16,
  `:4878` shows at most 4 values; 12 is inside both. Golden and planner tests that pin 4
  lookups at a time (`backend/tests/test_demo_chat_planner.py`, 8 mentions) need checking.

### 5.5 Everything that states or pins the old values

- Backend: `config.py` field defaults and `le`, `_CHAT_CHANGED_DEFAULTS` docs,
  `app_status.py:388-389` (reads live values, no change), `routes_chat.py:1702-1703` fallbacks
  `or 4` / `or 16`.
- Web UI: `chat-agent.tsx:49-72` (`CHAT_AGENT_DEFAULTS`), `:126-141`
  (`CHAT_AGENT_BOUNDS`), `chat-api.ts:213-227`.
- Docs: `docs/administration/settings.md:118-122` ("300 seconds by default", "(4)",
  "(16)"); `docs/reference/configuration.md:256, 275-279` (table) and `:301-311`
  (migration paragraph: add the version-2 step); `docs/reference/api.md:536-538`
  (defaults 4 and 16); `docs/USAGE.md:701`; `docs/analyst/chat.md:1223` ("goes silent for
  five minutes" becomes "fifteen minutes") and `:1228-1231` ("4 questions at once, and the
  backend 16"); `AGENTS.md:523` ("4/16"); `docs/operations/upgrades.md:478` and
  `DEPLOY.md:619-620` (add the Round 14 upgrade note); CHANGELOG `[Unreleased]`; regenerate
  the Help Center corpus.
- Tests: `backend/tests/test_chat_limits_migration.py:41-62, 86-89` (fresh defaults and the
  Round 12 move now land on the tripled values), `test_settings_schema_chat_agent.py:49-51`
  (300 / 900 / 4 / 16), `test_chat_round12_api.py:245-253` (4 / 16 and the 429 limit 4),
  `test_chat_contracts.py:560-588` (repair to default), plus the engine tests that use
  explicit values; `webui/src/soc/pages/settings/__tests__/chat-agent.test.tsx` (bounds pin
  and defaults).

---

## Open questions for the operator

1. Ask 1: option 1A (keep "Sign in to continue." after each notice) or 1B (drop it, since
   the sign-in card already says it)?
2. Ask 1: keep returning `lifetime_seconds` from the public `/auth/me` (no API change, the
   console ignores it) or stop sending it?
3. Ask 1: the Remember me hint still says "for up to 24 hours" before sign-in (a consent
   disclosure). Keep it? The research says yes.
4. Ask 4: option B (one gutter between all rows, recommended), A (keep 40px rows) or C
   (24px rows)?
5. Ask 4: add a short window caption to the flow ("last 24 hours") and to Response time,
   or rely on the sticky time-range picker in the masthead?
6. Ask 5: move `model_step_timeout_s` 300 to 900 for Bounded blocks too (recommended), or
   only Unlimited as in Round 12?
7. Ask 5: should the client's 5-minute wait for a free chat slot also triple? It is not
   under Timeouts and capacity today.
8. Ask 5: fix the report-summary timeout against the 300 s proxy in the same round?

## Sources

- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- HMRC design patterns, Service timeout: https://design.tax.service.gov.uk/hmrc-design-patterns/service-timeout
- DWP Design System, Manage a session timeout: https://design-system.dwp.gov.uk/patterns/manage-a-session-timeout
- DWP example, timed out signed in: https://design-system.dwp.gov.uk/patterns/manage-a-session-timeout/examples/timedout-signedin
- W3C, Understanding SC 2.2.6 Timeouts: https://www.w3.org/WAI/WCAG22/Understanding/timeouts.html
- NIST SP 800-63B-4, Session management: https://pages.nist.gov/800-63-4/sp800-63b/session
- Anthropic API rate limits: https://platform.claude.com/docs/en/api/rate-limits
- Elasticsearch 8.19 thread pools: https://www.elastic.co/guide/en/elasticsearch/reference/8.19/modules-threadpool.html
