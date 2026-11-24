# Round 15 platform map: pages, permissions, endpoints, budget, docs, CI, Demo

Reader 7 of 7 (platform constraints). Read only; no repository file was edited. Branch
`claude/round15` at `b49780c` ("Journal: Round 15 start"), working tree clean. Every
claim cites `path:line` at that commit. Measurements were taken on the checked-in tree
and the `webui/dist/` build that is present (dated 2026-11-10, entry
`dist/assets/index-BU2lQpgf.js`, 337,163 B; it matches the AGENTS.md "Round 14
baseline" figure; rebuild before relying on exact bytes, the last `webui/src` commit is
`4cb849a`, 2026-11-11).

---

## (a) Console feature registry, navigation, routes, palette, guards

### a.1 The one registry: `webui/src/soc/registry.tsx` (768 lines, an ENTRY module)

- `PageId` union, `registry.tsx:76-115` (39 ids). `ROUTES` is typed
  `Record<PageId, RouteDef>` (`registry.tsx:653`), so a new `PageId` will not compile
  without a `ROUTES` entry.
- `NavGroupId` union, `registry.tsx:117-123`: `overview | triage | intelligence |
  analytics | notifications | platform`. `FEATURE_GROUPS` (rail order + labels),
  `registry.tsx:557-564`: "Overview", "Triage", "Intelligence", "Analytics",
  "Notifications", "Platform". Exported to the console map as `nav_groups`.
- `FeatureNode` (`registry.tsx:161-201`): `id, label, icon?, group, perm?, target?,
  children?, hidden?, navPlacement?: 'main'|'footer', enabled?(ctx)`. `FeatureChild`
  (`registry.tsx:204-217`): `id, label, icon?, perm?, enabled?, target?`. Children are
  leaves (never nested further).
- Visibility authority: `featureEnabled(node, ctx)` (`registry.tsx:224-230`): an
  `enabled` override wins, else `!perm || ctx.hasPermission(perm.resource, perm.action)`.
  `FeatureCtx` has three axes: `hasPermission`, `prefsEnabled?`, `demoActive?`
  (`registry.tsx:144-154`); today only RBAC is used by callers (`navVisible`,
  `nav.ts:301`).
- Shared permission objects (an entry-budget device from FX7g):
  `METRICS_VIEW, CASES_READ, SOURCES_READ, COST_VIEW, RAG_READ, RUNBOOKS_READ,
  MEMORY_READ` (`registry.tsx:241-247`). Comment: "a row that needs one of these names
  the constant, never a copy."
- `FEATURES` (`registry.tsx:254-551`), order is authoritative (drives rail order):
  - Overview row `overview`, `target: 'dashboards'`, children `dashboard` ("Cyber
    Defence Center", `target: 'overview'`), `dashboards` (perm `metrics:view`),
    `standup` (`registry.tsx:256-280`).
  - Triage rows: `cases` (no perm), `case_manager` "Case Manager" (`cases:read`),
    `campaigns` (`cases:read`), `logs` (`sources:read`), `chat` "Workspace" with
    children chat / investigate / reports (`cases:read`), hidden `scans`, `approvals`
    (`proposals:read`) (`registry.tsx:283-337`).
  - Intelligence row with children knowledge (`rag:read`), runbooks (`runbooks:read`),
    memory (`memory:read`), personas (ungated) (`registry.tsx:340-375`).
  - Analytics row `analytics`, `target: 'metrics'`, children metrics, effectiveness
    (`metrics:view`), cost (`cost:view`), models, baseline (`settings:read`), batchjobs
    "Jobs" (`registry.tsx:378-415`).
  - Notifications row `inbox` with one child `inbox` (drawn as a plain row)
    (`registry.tsx:421-427`).
  - Platform rows: `sources` (`sources:read`), `audit` "Audit log" (`audit:view`),
    `tuning` "Auto-tuning" (`automation:read`), `settings` with children `users`
    (`users:manage`) and `roles` (`roles:manage`), and `docs` "Help Center"
    (`navPlacement: 'footer'`) (`registry.tsx:432-477`).
  - Hidden-but-routable entries (`registry.tsx:485-550`): dashboard, investigate, cost,
    models, standup, knowledge, runbooks, memory, catalog, playbooks, personas,
    account, sessions, security, roles, users, admin_sessions.
- Lazy page table (`registry.tsx:581-618`): every page is `React.lazy(() =>
  import('./pages/X'))`; host-tab leaves route through their host with a forced `tab`
  (`registry.tsx:666-686`, `727-736`). Login and Wizard are deliberately eager
  (`registry.tsx:578-579`, `App.tsx:31-35`). `renderRoute` falls back to Overview for an
  unknown id (`registry.tsx:764-768`). Comment at `registry.tsx:718`: routes that read
  their deep-link opts from the router have "no render thunk: entry budget".
- `App.tsx:208-214`: one `<ErrorBoundary resetKey={page}>` and one
  `<React.Suspense key={page} fallback={<PageSkeleton label={navLabel(page)} />}>`
  around `renderRoute(page, { opts, onRerunWizard })`.

### a.2 Derivation layer: `webui/src/soc/nav.ts` (306 lines, entry)

- `toNavItem` throws at module load when a visible feature has no icon
  (`nav.ts:132-141`).
- `NAV_GROUPS` (`nav.ts:162`): per `FEATURE_GROUPS`, the non-hidden `main` features; empty
  groups dropped. `NAV_FOOTER_ITEMS` (`nav.ts:171`), `NAV_ITEMS` (`nav.ts:176`),
  `NAV_CHILDREN` (`nav.ts:182`), `PAGE_IDS` = rail items + children + every FEATURES id,
  de-duplicated (`nav.ts:194`).
- `navTarget(item, has)` (`nav.ts:231`): a row opens its `target` while the viewer can
  see it, else its first visible child, else its own id. `navCurrentLabel(page)`
  (`nav.ts:263`) is the title the page must carry. `navLabel(id)` (`nav.ts:275`) falls
  back to the FEATURES label, then a humanised id. `isPageId` (`nav.ts:289`).

### a.3 The docked rail: `webui/src/soc/components/NavSidebar.tsx` (825 lines, entry)

- Reads `NAV_GROUPS`, `NAV_FOOTER_ITEMS`, `navTarget`, `navVisible` (`NavSidebar.tsx:63-73`)
  and filters per viewer with `useAuth().hasPermission` (`NavSidebar.tsx:106-129`).
- A group of several items gets a 12px heading; a group whose one item has the group's
  own label (Intelligence, Analytics, Notifications) gets a hairline
  (`repeatsItsItem`, `NavSidebar.tsx:183-209`; headings rendered at `NavSidebar.tsx:494-499`).
- The collapsed rail's flyouts/tooltips are the lazy chunk `nav-rail-interactions.tsx`
  loaded by `nav-rail-loader.ts`; never import it statically (guarded by
  `bundle-first-paint.test.ts:269-290`, `:445-480`).
- Open-group state persists in `nav-store.ts` (localStorage `soc.nav.openGroups` +
  `UserPrefs.misc.nav_open_groups`, `nav-store.ts:32-36`); the backend does not
  validate group ids (no match for `nav_open_groups` in `backend/app`).
- Normative rules: `docs/development/ui-standard.md:1197-1396` ("Navigation and
  information architecture"): registry is the only feature registry; "One name per
  page" (the page `h1`/title equals the current nav label); Primary navigation contains
  "distinct operator jobs, not alternate reports over the same objects"; one
  `aria-current="page"`; 64px rail / 240px drawer.

### a.4 Router and deep links: `webui/src/soc/router.tsx` (711 lines, entry)

- Hash router `#/<pageid>`; unknown id lands on `overview` (`routeFromLocation`, `router.tsx:346-357`).
- `SETTINGS_REDIRECTS` (`router.tsx:76-89`): account, security, sessions, users, roles,
  admin_sessions land in `#/settings?s=<section>`.
- `PAGE_REDIRECTS` (`router.tsx:287-294`): analytics, dashboard, playbooks, catalog,
  scans.
- `DEEP_LINK_KEYS` (`router.tsx:160-198`) and `hashKeys` (`router.tsx:213-235`): every
  query key a page owns and its validator; a key not listed makes the whole query fail
  closed (`parseOpts`, `router.tsx:322-336`). Case Manager owns `caseId`, `closedBy`
  (`agent|analyst|analyst_policy|system`) and `tab` (validated by `isCaseTab` from
  `webui/src/soc/case-tabs.ts:10`, `CASE_TABS = ['overview','runbook','timeline',
  'investigation','threat','collab','chat']`; Alt+1..7 follow this order).
  Adding a tab to the case detail or a new deep-link key for a new page edits an entry
  module and costs entry bytes.

### a.5 Command palette: `webui/src/soc/components/CommandPalette.tsx` (561 lines, LAZY)

- Mounted lazily by AppShell (`AppShell.tsx:161-170`, `1062-1074`, `2097`), warmed by a
  prefetch of a build-written chunk list (`'__CHUNK_LIST:src/soc/components/CommandPalette.tsx__'`,
  `AppShell.tsx:164`).
- Destinations are derived from `NAV_GROUPS` + `NAV_FOOTER_ITEMS`, each row and child
  through `navVisible` and `navTarget`/`navDest` (`CommandPalette.tsx:221-270`). Blank
  state: top-level destinations only; children and Settings sections after typing
  (`ui-standard.md` palette bullet). Settings targets come from
  `searchJumpTargets` (`settings-sections-meta.ts`). So a new registry entry appears in the
  palette with no palette edit.
- Backend `routes_search.py:54-78` keeps a static `_NAV_TARGETS` list (stale labels such
  as "Automated scans", "Investigate"); the Console palette does not read `nav` from
  `/api/search` (no `.nav` use in `webui/src`). No update needed for a new page.

### a.6 Route guards by permission

- There is no guard in `renderRoute`; the registry `perm` only hides the row, palette
  entry and console-map link. A typed or shared URL still mounts the page.
- Pages self-guard:
  - `ProtectedRoute` / `Unauthorized` / `Can` / `useCan` in
    `webui/src/soc/components/Can.tsx:28-73`. Used by Audit (`pages/Audit.tsx:891`,
    `audit:view`), Baseline (`:85`), Models (`:96`), AdminSessions (`:55`), Users (`:96`),
    Roles (`:150`), Campaigns (`:138`), CaseManager (`pages/CaseManager.tsx:1910`,
    `cases:read`), Tuning (`:407`).
  - `PageAccess` (`webui/src/soc/pages/PageAccess.tsx:142`, Round 14): renders the page
    title and one refusal, mounts nothing without the grant (so no 403 read and no
    Access denied audit row), and distinguishes "grants could not be loaded"
    (`GRANTS_UNKNOWN_TITLE`) from a refusal. Used by Metrics, AgentEffectiveness, Cost,
    Sources, UnifiedLogs. Use this for a new gated page.
- `hasPermission` (`webui/src/soc/auth.tsx:199-214`): auth off allows all; `super_admin`
  allows all; grants load failure denies all; RBAC off (clean read) allows all; else
  the server's concrete grants (`GET /api/account/permissions`). Grants load once per
  `refresh()` (`auth.tsx:105-140`). A Console RBAC switch must call `refresh()` after
  saving, or this tab keeps the old allow-all/deny answers; other open tabs learn only
  on their next refresh (the server enforces regardless). `PageAccess` infers "grants
  unknown" from "RBAC off + a denial" (`PageAccess.tsx:31-40`), which stays valid.
- Backend RBAC mode is read from the REAL prefs: `deps._rbac_enabled` reads
  `state.prefs.rbac.enabled` (`backend/app/api/deps.py:393-395`), not the Demo execution
  prefs; `_enforce`/`require_permission`/`has_permission` at `deps.py:979-1030`.

### a.7 Tests that enumerate the registry or navigation (update with any nav change)

| Test | What it pins |
|---|---|
| `webui/src/soc/__tests__/nav-derivation.test.ts` | every NAV_ITEM has an icon; hidden-only ids `['catalog','account','sessions','security','admin_sessions']` resolve via FEATURES; Case Manager directly beneath Cases with `cases:read` (`:47-56`); Intelligence children exact list (`:58-83`); Approvals `proposals:read`; footer is exactly `['docs']` (`:92-97`); scans hidden |
| `webui/src/soc/__tests__/route-registry.test.tsx` | every PAGE_ID has a lazy ROUTES entry; an `EXPECTED` list of 37 documented ids (`:31-44`); every element is `React.lazy` |
| `webui/src/soc/__tests__/registry-router-round6.test.tsx` | host-tab children route through hosts (`:58-82`); standalone children list `['dashboards','models','baseline','batchjobs','inbox']` (`:86-92`); Analytics gates; `FEATURES.find(f => f.id==='cost' && f.hidden)?.perm` (`:121`); Sources/Logs `sources:read` |
| `webui/src/soc/__tests__/nav-titles.round14.test.ts` | every visible destination page must be in `TITLE_SOURCES` (`:27-53`) and its source must write the nav label AS ITS TITLE (`title=`, `PAGE_TITLE =`, or `<h1>`) (`:69-96`, `:126-145`). A new nav page fails here until both are done |
| `webui/src/soc/__tests__/nav-target.round14.test.tsx` | `navTarget` for analytics/overview rows |
| `webui/src/soc/__tests__/nav.behaviour.test.tsx` | the collapsed rail's tab order, exactly 14 destinations, "reaches Settings as the 16th tab stop" (`:833-859`); Analytics child order `['Cost','Models','Baseline','Jobs']` without metrics:view (`:748`); Overview children (`:762-763`); Intelligence children (`:905`); exactly 2 group headings, Triage and Platform (`:921-929`) |
| `webui/src/soc/__tests__/console-map.contract.test.ts` | derives `backend/app/knowledge/console_map.json` from FEATURES + Settings metadata and requires it byte-identical (`:299-315`); `PAGE_KEYWORDS` overlay (`:93-148`) must name real pages (`:432-445`); page targets cover every visible feature (`:348-362`) |
| `webui/src/soc/__tests__/dashboards-route.test.tsx`, `reports-route.test.tsx` | Overview/Workspace children |
| `webui/src/soc/__tests__/settings-redirects.test.ts` | Settings redirects |
| `webui/src/soc/__tests__/command-palette.test.tsx` | unique palette rows for queries incl. 'Approvals','Users','Roles' (`:298-310`) |
| `webui/src/soc/__tests__/auth.effective-permissions.test.tsx` | Audit log link visibility by grant |
| `webui/src/soc/__tests__/appshell.search.test.tsx:201-213` | uses `nav-tuning` |
| `webui/src/soc/__tests__/router-deep-links.round14.test.tsx`, `pages/__tests__/CaseDetail.tabs.test.tsx` | `CASE_TABS` and the `tab` deep link |
| `webui/src/soc/__tests__/bundle-first-paint.test.ts` | entry budget and lazy boundaries (b below) |

Adding a top-level rail row changes the nav.behaviour tab-order list and the "16th tab
stop" assertion (a Round 14 SPEC acceptance line, `docs/research/2026-10-round14/SPEC.md:1744`).
Adding a new group with more than one item, or one whose single item is named
differently from the group, adds a heading (the "exactly 2 headings" test).

### a.8 Settings sections (if a feature adds a section or card, e.g. the RBAC switch)

- Metadata: `webui/src/soc/pages/settings/settings-sections-meta.ts` (LAZY; must stay
  off first paint, `bundle-first-paint.test.ts:246-267`). Groups
  `SECTION_GROUP_ORDER` (`:92-98`): Account, General, Integrations, Security & access,
  Organization. Sections `SETTINGS_SECTIONS_META` (`:148-`); Security & access holds
  `admin_users` "Users" (`users:manage`), `roles` "Roles & permissions"
  (`roles:manage`), `security` "Single sign-on & policy" (`settings:manage`, owns
  `sso, session_policy, mfa`), `admin_sessions`, `keys` (`:433-490`). Cards:
  `SETTING_ANCHORS` (`:616-`).
- The RBAC posture row ("Role-based access") is in `pages/settings/security.tsx:52`;
  the Roles page warns "Role-based access is off" (`pages/Roles.tsx:350`); both lazy, so
  a switch there costs no entry bytes.
- Every Settings section becomes a console-map target and an "Ask about this" topic
  automatically (`console-map.contract.test.ts:249-291`), and every topic question must
  route to product help (`backend/tests/test_app_knowledge.py:552-555`).
- `pages/settings/__tests__/settings-sections.test.ts` pins every section id and the
  order inside each group (`:65-150`).

---

## (b) Entry-bundle budget

### b.1 The test

`webui/src/soc/__tests__/bundle-first-paint.test.ts` (599 lines):
- `PRE_REVAMP_ENTRY_BYTES = 336_216` and `REVAMP_ENTRY_BUDGET_BYTES = 1_024`
  (`:158-159`); the history of every rebase is the comment `:46-157`.
- Hard ceiling `expect(bytes).toBeLessThan(400_000)` (`:225-234`); budget
  `bytes - PRE_REVAMP_ENTRY_BYTES <= 1_024` (`:236-244`); bytes = `fs.statSync` of the
  `index-*.js` that `dist/index.html` loads.
- Build-artifact cases run only with a `dist/` present, and are mandatory in CI with
  `REQUIRE_DIST_BUILD=1` (`:41`, `:176-182` and the CI step `.github/workflows/ci.yml:643-646`).
  Source-level guards always run: the first-paint static import graph from
  `src/main.tsx` must not reach CommandPalette, `ui/command`, Settings metadata,
  `settings-dirty`, the rail layer, `nav-hover-intent`, `nav-rail-tip`,
  `field-layouts`, `settings/primitives`, `motion`, `framer-motion`, `react-dom/server`
  or `chat/report` (`:381-599`).
- Entry may statically import only vendor chunks `react-vendor|radix|icons|utils`
  (`:336-347`).
- Ran it here against the present dist: 25 of 25 pass in 1.8 s.

### b.2 Where the entry is today

337,163 B locally: 947 B over the baseline, **77 B of headroom**. A CI build stamps
`TLSOC_BUILD_SHA` (40 chars) and `TLSOC_BUILD_DATE` (20 chars) into the entry where a
local build writes `"unknown"` twice (`release.config.ts:68-69`, visible in the entry as
`commitSha:"unknown",buildTime:"unknown"`), about +46 B (stated at
`bundle-first-paint.test.ts:97-99`). So the CI build lane (the binding one) has roughly
**31 B** of headroom. Round 14 SPEC §11.1 "Entry bundle" ends: "the 77 B left means the
next first-paint addition is likely to need its own bytes found first"
(`docs/research/2026-10-round14/SPEC.md:3580-3583`).

Per-source attribution of the 337,163 B entry (source map, measured here; top entries):
AppShell.tsx 33,550; sonner 32,974; **pages/Wizard.tsx 28,245**; pages/Login.tsx 21,682;
lib/api.ts 14,444; SystemUpdateControl.tsx 13,850; NavSidebar.tsx 12,786;
**registry.tsx 9,981**; MfaSetupCard.tsx 9,132; NotificationBell.tsx 8,610;
**router.tsx 7,571**; source-marks.ts 7,056; useDeploymentUpgrade.ts 6,489;
jobs/jobs.ts 6,331; loginParts.tsx 6,216; unmapped 6,073; LoginAuthBackdrop 5,380;
theme-tokens.ts 4,997; JobMonitor.tsx 3,951; DemoIndicator 3,626; theme.tsx 3,505;
ui/sheet 3,367; design-system/loading 3,292; ui/dropdown-menu 3,144; prefs.tsx 2,920;
nav-store.ts 2,788; ReauthDialog 2,608; App.tsx 2,476; **auth.tsx 2,249**;
**lib/useEventStream.ts 2,216**; useReturnFocus 2,137; lib/format.ts 2,109;
nav.ts 1,645; Can.tsx 605; case-tabs.ts (in the router's import). (Script used:
scratchpad `round15/understand/tools/attr.cjs`.)

Entry modules by Round 14 SPEC §3.4 (`SPEC.md:381-415`): App, AppShell, NavSidebar,
router, registry, nav, nav-types, auth, Login and Wizard (eager), ui/sheet, **lib/api.ts
("every method added to it ships in the entry")**, lib/format, lib/useEventStream
(`STREAM_CHANNELS`), the design-system index as far as AppShell imports it, the
chat-activity store. Rule: **new client calls never go into api.ts**; they go in lazy
modules (`lib/api-audit.ts`, `api-runbooks.ts`, `api-dashboards.ts`, `api-rules.ts`
follow the pattern, e.g. `api-audit.ts:1-12`), and new TS mirrors in type-only modules
(`types-*.ts`, zero bytes).

### b.3 What things cost (measured on the minified entry)

| Change | Approx. entry bytes | Evidence |
|---|---|---|
| A visible FEATURES row with a shared perm constant | ~66 B (`{id:"campaigns",label:"Campaigns",icon:X,group:"triage",perm:Y},`) | measured |
| A child entry | ~40 B (`{id:"cost",label:"Cost",icon:pa,perm:Ma}`) | measured |
| An inline perm object / a new shared perm constant | ~37 B (`Mn={resource:"metrics",action:"view"}`) | measured |
| A new standalone lazy page const | ~138 B average (21 consts: `X=a.lazy(()=>ne(()=>import("./P-hash.js"),__vite__mapDeps([..~35 indices..])))`) | measured |
| Its chunk name in the preload table `m.f=[…]` | ~31 B, plus ~31 B per new shared chunk it creates | measured (116 entries today) |
| A bare ROUTES entry | ~22 B (`campaigns:{element:lm}`) | measured |
| A host-tab ROUTES entry with a render thunk | ~51 B (`cost:{element:Et,render:()=>s.jsx(Et,{tab:"cost"})}`) | measured |
| A new lucide icon binding in the entry's import | a few bytes (icon body lands in the `icons` vendor chunk, which is not counted) |, |
| A new `DEEP_LINK_KEYS` page/key with a validator | ~20 to 60 B | `router.tsx:160-198` |
| A new SSE channel in `STREAM_CHANNELS` | ~15 to 20 B | `useEventStream.ts:89-104` |
| A new `CASE_TABS` entry | ~10 B | `case-tabs.ts:10` |
| Any copy change in `Wizard.tsx` or `Login.tsx` | the string length delta, 1 B per char | both eager |
| A method on the `api` object in `lib/api.ts` | ~60 to 120 B | `api.ts:753` |

So a new standalone navigation page costs about **260 to 330 B** (row + lazy const +
m.f + route), a page routed through an existing lazy host as a tab about **120 B**
(child + render thunk), against ~31 B of CI headroom. **Any new nav destination needs
bytes found first or a recorded rebase.**

### b.4 How earlier rounds stayed inside (precedents for the SPEC)

- Round 12 WP-GEN-A: palette body (cmdk) and Settings metadata made lazy, -34,420 B
  (`bundle-first-paint.test.ts:66-80`).
- Round 14 package R: rail interaction layer lazy (`nav-rail-interactions.tsx`), Field
  layouts lazy, -7,719 B (`:117-136`); W9b made the wizard's SourceEditor lazy
  (-36 kB, `SPEC.md:3527-3533`); retired client methods removed from api.ts (-2,576 B).
- FX7g: one shared object per repeated permission in registry.tsx, about -187 B
  (`SPEC.md:3576-3578`); an optional auth flag (+18 B) was left out for budget.
- Routes without render thunks where the page reads opts from the router
  (`registry.tsx:718`).
- Rebase protocol (Round 14 E11, `SPEC.md:295-298`, `:404-412`): only the orchestrator
  rebases, at most once, after the packages that touch entry modules are committed,
  with per-file before/after bytes attributed through the source map and a written
  justification in the test comment, the SPEC record and the Journal; the 400,000 B
  ceiling never moves. Round 14 later ratcheted the baseline DOWN to 336,216 B.
- A rebase is pinned by `backend/tests/test_docs_round12_records.py:239-263`: the
  Round 14 SPEC §11.1 "Entry bundle." bullet must contain
  `PRE_REVAMP_ENTRY_BYTES = <value>` and `<value:,> B` and the names `nav-store.ts`,
  `router.tsx`, `nav-rail-loader.ts`, `nav-rail-interactions.tsx`, `Field.tsx`,
  `field-layouts.tsx`. A Round 15 rebase must either update that bullet or repoint the
  test to a Round 15 SPEC record (as Round 14 repointed Round 12's).

### b.5 Byte sources a Round 15 design could use (no behaviour change)

- 11 hidden FEATURES entries duplicate a visible child of the same id and label:
  dashboard, investigate, cost, models, standup, knowledge, runbooks, memory, personas,
  roles, users. Measured **818 B** in the entry. They add nothing to `PAGE_IDS`
  (children are already in it, `nav.ts:194-200`) or to labels (`navLabel` checks
  `NAV_CHILDREN` first, `nav.ts:275-287`). Risks: `registry-router-round6.test.tsx:121`
  pins the hidden `cost` entry's perm; `navTarget` falls back to `FEATURES.find` only
  for a target that is not a child (`nav.ts:243`), which none of these is. Keep
  catalog, playbooks, account, sessions, security, admin_sessions (redirect sources and
  `nav-derivation.test.ts:33-39`).
- Wizard copy fix (ask 2) touches `pages/Wizard.tsx` (eager): `:119`
  ("Add a provider credential for live investigations, or use the mock runtime."),
  `:816`, `:1332` ("Mock runtime available"), `:1339`, `:1342` ("You can continue
  without a key, but live investigations will use the limited mock runtime until a
  provider is added."), `:1409`, `:1464-1465` ("No provider configured · mock runtime
  only"). Shorter copy saves bytes; longer copy spends them.

---

## (c) Backend routers, OpenAPI, generated types, TS mirrors

### c.1 Feature router auto-discovery

- `backend/app/main.py:35-69` `discover_feature_routers()`: every
  `app/api/routes_<feature>.py` with a top-level `router: APIRouter` is imported (raise
  on failure), sorted by name, and mounted with `Depends(require_auth)`
  (`main.py:162-163`). The base `routes.py` router is mounted separately
  (`main.py:154`). "Add a feature" = drop a `routes_*.py` file; no edit to main.py.
- Convention: `APIRouter(prefix="/api")`; GETs inherit auth only; every mutating route
  declares `Depends(require_permission(resource, action))` (`deps.py:1009-1016`),
  `has_permission` for in-body decisions without an audit row (`deps.py:1019-1030`),
  `require_fresh_auth()` for step-up (`deps.py:1071`), `require_admin`
  (`users:manage`, `deps.py:1062`).
- Today 39 `routes_*.py` files (`ls backend/app/api/routes_*.py`).
- Records tests that a new router file breaks:
  - `backend/tests/test_docs_round13_records.py:51-54`: AGENTS.md must contain
    `**{N} \`routes_*.py\` feature routers**` with the exact count (today "**39
    `routes_*.py` feature routers**" in AGENTS.md §4).
  - `test_docs_round13_records.py:175-180`: `docs/HANDOFF.md` must contain
    `**{N} feature routers total**` (today `HANDOFF.md:439`) and name every router module
    by word boundary.
  - `test_round5_coupling_routes.py:31-48` (sorted, routes_ prefix only, base excluded).
  - CI "Backend package integrity" asserts the installed wheel discovers sorted unique
    routers (`ci.yml:160-165`).
- Existing precedent for "user activity": `GET /api/account/activity` in the BASE router
  (`backend/app/api/routes.py:4391-4402`, the caller's own audit rows by actor via
  `_records_for_actor`), with the Console client in `lib/api.ts:888-891` (entry). New
  endpoints should go in a new `routes_*.py` and a lazy client module.

### c.2 OpenAPI and generated types

- `webui/scripts/gen-types.mjs`: imports `app.main:app` offline with
  `../backend/.venv/bin/python` (or `TLSOC_PYTHON`), writes `webui/openapi.json`
  (`json.dumps(..., indent=2, sort_keys=True, ensure_ascii=False)`), then runs
  `openapi-typescript` to `webui/src/lib/api-types.gen.ts` (type-only, 0 runtime bytes).
- `webui/scripts/check-types.mjs`: regenerates and fails on any byte difference from the
  working tree; skips softly when the backend is not importable unless
  `TLSOC_REQUIRE_TYPEGEN=1`. CI lane "TypeScript & OpenAPI drift" runs
  `npm --prefix webui run check:types` then `typecheck` (`ci.yml:519-544`).
- Today `openapi.json` has 293 paths; `api-types.gen.ts` is 25,575 lines.
  `FastAPI(..., separate_input_output_schemas=False)` (`main.py:117-121`).
- Regenerate: `cd webui && npm run gen:types`, commit both files.

### c.3 Hand mirrors (`webui/src/lib/types.ts` and `types-*.ts`)

- AGENTS.md §8: "Keep `webui/src/lib/types.ts` in sync with `models.py`".
- Round 14 pattern: new mirrors in type-only `types-audit.ts`, `types-dashboards.ts`,
  `types-rules.ts`, `types-runbooks.ts`, re-exported by `types.ts`; each mirror whose
  schema has the same name is pinned (field names both directions, closed
  vocabularies) in `webui/src/lib/types-contract-pins.ts` (`:1-21`), which `tsc
  --noEmit` checks.
- `webui/src/lib/__tests__/round14-client.test.ts` checks every listed client call
  names a real path, method, query parameter and body field of `openapi.json`, that
  every mirror module is pinned (`MIRROR_MODULES`, `:639`), and that `types.ts`
  re-exports them without collision. A Round 15 client module and mirror module should
  be added to an equivalent contract test.
- Backend side: `backend/tests/test_round14_contracts.py` reads TS mirrors
  (`_ts_interface_fields`) and pins the Roles editor's hand mirror
  `RESOURCE_ACTIONS` in `webui/src/soc/pages/Roles.api.ts:134-159` to
  `rbac.policy.RESOURCES` exactly (`test_round14_contracts.py:1137-1172`,
  `_ROLES_MIRROR_PENDING` and `_ROLES_MIRROR_RETIRED` are empty ratchets).

### c.4 Adding a permission (resource or action): every place

1. `backend/app/rbac/policy.py:51-99` `RESOURCES` (canonical vocabulary).
2. `DEFAULT_MATRIX` rows `policy.py:434-520` (`_SUPER_ADMIN` is derived `[ALL]` for every
   resource; `_SOC_MANAGER`, `_ANALYST_TIER2`, `_ANALYST_TIER1`, `_RESPONDER`,
   `_AUDITOR` are explicit; `_settings_like` derives narrow resources from `settings`).
   Roles: `super_admin, soc_manager, analyst_tier2, analyst_tier1, responder, auditor`
   (`backend/app/constants.py:584-595`). The auditor is "read/view only across the board"
   (`policy.py:495-497`).
3. Stored overrides are deep-additive (an absent resource falls back to the default),
   so a new resource needs no grant migration; `RBAC_GRANTS_VERSION = 2`
   (`policy.py:126`) only matters if an existing meaning changes.
4. `webui/src/soc/pages/Roles.api.ts:134-159` `RESOURCE_ACTIONS` (pinned, c.3).
5. `docs/reference/permissions.md` tables (`:39-56` and following); the page is in the
   chat corpus (`scripts/build_app_knowledge.py:73`), so regenerate the corpus.
6. Tests pinning holders: `test_round14_contracts.py:78-142`, `tests/test_rbac_policy.py`
   (truth table, `:34-191`), `tests/test_account_permissions_effective.py`,
   `tests/test_round3_wave1_rbac.py`.
7. If a nav row or Settings section gates on it, the console map regenerates (its
   `requires`), and `console_grant_pairs()` (`backend/app/knowledge/render.py:144-152`)
   picks it up for `ConsoleLink.allowed`.
8. Existing grants a "team activity" view could reuse: `audit:view` (soc_manager,
   auditor), `users:manage` (soc_manager), `metrics:view` (every role). No role named
   "team lead" exists.

### c.5 Audit event names (every new writer)

- New audit actions must be categorised in `backend/app/audit/event_categories.json`
  (read by `backend/app/audit/events.py`) and mirrored in
  `webui/src/soc/components/audit/events.ts`, which
  `webui/src/soc/components/audit/__tests__/events.contract.test.ts:30` compares to the
  JSON. Also `tests/test_round14_runbook_event_labels.py`.
- Audit-before-visible helper `audited_write` in `backend/app/audit/write.py`
  (contract: Round 14 SPEC §3.6, `SPEC.md:445-477`): pre-checks write no row; append the
  action row (503 `audit_unavailable` on failure, nothing changes); then the store write
  (failure row `<resource>.<verb>_failed`); only then the SSE frame. Every plain
  `record` call in the base router must carry `outcome` and `actor_type`
  (`tests/test_audit_route_outcomes.py`).

---

## (d) SSE event topics

- Bus: `backend/app/realtime.py` (632 lines). Channel (event type) names, the one
  registry: `AGENT_STEP_EVENT "agent.step"`, `CASE_ACTIVITY_EVENT "case.activity"`,
  `INAPP_EVENT "inapp"`, `JOB_EVENT "job"`, `CHAT_TURN_EVENT "chat.turn"`,
  `CHAT_READ_EVENT "chat.read"`, `CASE_CHANGED_EVENT "case.changed"`,
  `CASE_RUNBOOK_EVENT "case.runbook"`, `OVERFLOW_EVENT "overflow"`
  (`realtime.py:93-101`), `SSE_EVENT_TYPES` (`:103-113`). Topics: `CHAT_TOPIC "chat"`,
  `CASES_TOPIC "cases"`, `RUNBOOKS_TOPIC "runbooks"` (`:115-124`). Publishers are
  fire-and-forget and swallow errors: `publish_chat_turn` (`:472`),
  `publish_case_changed` (`:521-550`, payload `{case_id, status, updated_at, created}`
  only, never log-derived text, #7/#9), `publish_case_runbook` (`:553-579`).
- Endpoint `GET /api/events` (`backend/app/api/routes.py:458-529`): allowlist
  `_REALTIME_TOPICS = {"notifications","inbox","jobs","cases","agent","chat","runbooks"}`
  plus exact `cases:{id}` rooms (`routes.py:432`); per-topic grants
  `_REALTIME_TOPIC_GRANTS = {"cases": (cases:read,), "runbooks": (runbooks:read,
  cases:read)}` (`routes.py:438-448`), dropped silently (no audit row) by
  `gate_realtime_topics` (`routes.py:451-455`); 204 when realtime is off or every topic
  is gated away. Default topics `notifications,cases,agent`.
- Browser: `webui/src/lib/useEventStream.ts` (ENTRY; 2,216 B). `STREAM_CHANNELS`
  (`useEventStream.ts:89-104`) must list every backend `*_EVENT` name exactly;
  `useEventStream(topics, { enabled, onEvent })` returns `{ live }`; callers keep
  polling while `!live` (`:132-`). Subscribers today: CaseActivityFeed and CaseThread
  (`cases:{id}`), NotificationBell, JobMonitor, chat-activity, runbooks/run/live.ts
  (`runbooks`, leader tab only), BatchJobs (`jobs`), CaseManager
  (`['cases','jobs']`, `pages/CaseManager.tsx:1333`), Inbox.
- Parity tests: `backend/tests/test_sse_agent_step_channel.py:43-58` (exact
  `SSE_EVENT_TYPES` set) and `webui/src/lib/__tests__/useEventStream.test.tsx:280-330`
  (every `*_EVENT = "..."` in realtime.py is in `STREAM_CHANNELS`);
  `test_durable_jobs_adversarial.py:1955-1957` (`jobs`, `inbox` in `_REALTIME_TOPICS`).
- Demo: the Demo stack has its own `EventBus(history_per_topic=0)` and Demo case saves
  publish on it (`backend/app/engine/demo_runtime.py:218-229`).
- Implication: attachment or review changes that save the Case already nudge
  `case.changed` on `cases` at no new cost. A new channel costs entry bytes
  (`STREAM_CHANNELS`) plus both parity tests; a new topic needs `_REALTIME_TOPICS`, a
  grant row, and the docs section `docs/reference/api.md:1227-1254` ("Realtime events").

---

## (e) Help Center, knowledge corpus, chat

### e.1 Pages likely to change

- Nav is `mkdocs.yml:121-201`; `scripts/check_docs.py` fails when a public page is not
  in nav or appears twice (`:153-174`), and checks links, anchors, hidden characters,
  obsolete terms and the five top-level sections (`:52-58`). 84 pages today.
- Ask 1 (RBAC switch): `docs/administration/users-rbac.md:11-47` ("Turn on role-based
  access": "The 0.1.13 Console has no switch for it", curl recipe);
  `docs/administration/settings.md:164`; `docs/getting-started/first-run.md:54`;
  `docs/getting-started/install.md:206`; `README.md:440`; `INSTALL.md:699`;
  `DEPLOY.md:1031`; `docs/reference/permissions.md:12-23` (authorization modes).
- Ask 2 (wizard copy): `docs/getting-started/first-run.md:309-349` (warning "Known issue in
  0.1.13: the mock runtime wording" and "Ready with limited capabilities"); `README.md:462`;
  `docs/getting-started/first-run.md:138-141` and `docs/USAGE.md:196` (Demo mock runtime,
  correct as is).
- Asks 3 and 4 (activity, team work page): a new or extended page under "Administer"
  (`administration/*.md`) or "User and analyst guide"; `docs/administration/audit-log.md`
  overlaps ("who did what"); `docs/reference/permissions.md` if a grant is added;
  `docs/reference/api.md` "Endpoint groups" table (`:119-161`; note the row
  "Account and sessions ... activity") and a section per contract.
- Asks 5 and 6 (Case Manager): `docs/analyst/case-manager.md` (sections "The outcome of a
  case" `:20`, "Keyboard" `:90`, "Read the workspace" `:122`, "Single-case actions"
  `:265`, "Close or resolve with a disposition" `:274`, "Authority and audit" `:351`,
  "Cases the agent closed" `:371`); `docs/analyst/cases.md`;
  `docs/concepts/deterministic-decisions.md` (review sampling must not read as a second
  close authority, #3); `docs/releases/known-limitations.md` (new limits, e.g. upload
  size); `docs/development/ui-standard.md` "Queue and detail workspaces" (`:550-640`)
  and "Activity and audit logs" (`:482-521`).
- Records: `CHANGELOG.md` exactly one `## [Unreleased]` (`scripts/check_version.py:644-650`);
  `Journal.md`; `AGENTS.md`/`docs/HANDOFF.md` router counts (c.1) and, if a
  `docs/research/2026-11-round15/` folder is created, both must name Round 15 as the
  newest (`test_docs_round13_records.py:183-190`: HANDOFF `**Round 15 ... (newest`,
  AGENTS `**Round 15 ... is the newest`).

### e.2 Console map and the corpus

- Order: `cd webui && npm run gen:console-map` (vitest in `console-map-write` mode
  rewrites `backend/app/knowledge/console_map.json`), then
  `python scripts/build_app_knowledge.py` (rewrites `app_docs.json`, `aliases.json`,
  `manifest.json`; the manifest pins the console map sha256 and the loader fails closed
  on mismatch). CI runs `python scripts/build_app_knowledge.py --check` in the docs lane
  (`ci.yml:603-604`).
- Corpus scope: guide tier `getting-started/ analyst/ automation/ intelligence/
  administration/ sources/ concepts/` + `index.md`, `architecture/ingestion.md`,
  `reference/permissions.md`; operate tier `operations/` + install, configuration,
  security, known-limitations, channels (`build_app_knowledge.py:66-79`).
  `reference/api.md` is excluded (`test_app_knowledge.py:136`).
- Bold breadcrumbs `**A → B → C**` in docs resolve to console-map targets or fail the
  build unless allowlisted (`build_app_knowledge.py:176-185`, `:566-579`). New docs must
  write breadcrumbs with the exact nav labels.
- Keyword overlays: `PAGE_KEYWORDS` in `console-map.contract.test.ts:93-148`. Today
  `audit` owns `'audit log','activity','who did what','audit events','audit record'`
  (`:144`). A "team activity" page competes for "activity"/"who did what": the Round 14
  tests that route audit questions to `page:audit`
  (`test_app_knowledge.py:1095-1175`, `:1365-1410`) must keep passing; the keyword
  overlay may also need a `CONSOLE_KEYWORD_DROP`-style split (`console-map.contract.test.ts:186-188`).
- Retrieval golden set `test_app_knowledge.py:236-275` (recall@3 >= 0.9) and Round 14
  destination tables (`:1060-1093`) via `_role_grants(role)` and `console_grant_pairs`.
- Chat golden set `backend/tests/test_chat_golden_set.py` (3,763 lines, runs end to end in
  Demo Mode through `POST /api/chat/stream`): product-help questions at `:483-583`;
  `READ_ONLY` `:606-613` includes "List the console users" as `unsupported=True` (no
  lookup reads users). A new chat tool reading activity would change that row and need
  Demo planner support in `backend/app/engine/demo_chat.py` (15,098 lines).
- `classify_intent("how do I close this case") == "data"` (`test_app_knowledge.py:558-560`):
  a close-flow help question phrased that way routes to data, not docs.
- Docs bundle: `npm run docs:bundle` / `docs:check` (`webui/package.json`),
  `python scripts/test_build_docs_bundle.py`, `python scripts/test_docs_theme.py`.

---

## (f) CI lanes and the local gate

`.github/workflows/ci.yml` jobs (timeout): repository-contracts (5 min, `check_version.py`);
**backend-tests (35 min, `python -m pytest -q`)**; verdict-stability (15,
`tests/test_verdict_stability_gate.py`); backend-package (10, wheel + runtime data +
router discovery); backend-smoke (10); postgres-redis (15; runs every
`tests/test_postgres_*.py`, which `scripts/check_ci_contract.py:29-36` requires to be listed in
`ACCEPTANCE_MODULES`, `ci.yml:398-455`, and fails if any skipped); rollback-lane (20; boots the
previous release `45a4c31` pinned in `scripts/rollback_previous_release.json` on this
release's PostgreSQL data, so new KV namespaces must be harmless to the old build);
**webui-tests (25 min, `npm run test:strict`)**; types-and-api (15, `check:types` +
`typecheck`); webui-lint (10, `npm run lint -- --max-warnings=0`); design-gates (10,
`npm run gates`); docs (15: `check_docs.py`, bundle and theme tests,
`build_app_knowledge.py --check`, versioned bundle build); **webui-build (15: `npm run build`
with the CI stamp, then `REQUIRE_DIST_BUILD=1 npx vitest run
src/soc/__tests__/bundle-first-paint.test.ts`)**; workflow-shell-contracts (5,
`check_ci_contract.py` + its unittest + ShellCheck); bootstrap-bash32 (5);
deploy-contracts (10); python-static (10, `ruff check backend/app backend/tests
updater/agentic_soc_updater scripts --select E9,F63,F7,F82`); **container-images (35, three
images)**; and the fail-closed aggregate "CI passed" (`ci.yml:1010-1060`).

Local full gate (AGENTS.md §7, `docs/development/testing.md:52-320`):

```bash
cd backend && .venv/bin/python -m pytest -q        # 12,567 tests collected here (9.6 s to collect)
cd backend && .venv/bin/python -m pytest -q -rs tests/test_verdict_stability_gate.py
python -m ruff check backend/app backend/tests updater/agentic_soc_updater scripts --select E9,F63,F7,F82
cd webui && npm run test:strict                    # 652 test files; zero stderr / console allowed
cd webui && npm run lint -- --max-warnings=0
cd webui && npm run gates                          # tokens, contrast, grep baseline (text-[..], raw hex), CVD, login accents
cd webui && npm run typecheck && npm run check:types   # needs backend/.venv importable
cd webui && npm run build                          # MkDocs bundle + tsc + vite
cd webui && REQUIRE_DIST_BUILD=1 npx vitest run src/soc/__tests__/bundle-first-paint.test.ts
cd webui && npm run docs:check
python scripts/check_docs.py && python scripts/test_build_docs_bundle.py && python scripts/test_docs_theme.py
python scripts/build_app_knowledge.py --check      # after npm run gen:console-map + build_app_knowledge.py
python scripts/check_version.py && python scripts/check_ci_contract.py
```

- Slow ones: the full backend suite (Journal records 2,072 tests in 106-146 s in an
  earlier round; the 12.5k suite's wall time is not recorded; CI allows 35 min), the
  full Vitest run (CI 25 min; Round 14 records load-only timeouts when run beside other
  work, "pass alone"), `npm run build` (docs + app), container images (CI only;
  registries are blocked in this sandbox, AGENTS.md §6a).
- Known sandbox failures: 5 environment tests fail here with the sandbox's proxy and AWS
  variables set and pass with them unset (Journal 2026-11-10 entries). PostgreSQL-only
  modules skip offline (22 skips).
- `test:strict` fails on any stderr byte or captured console output
  (`webui/scripts/test-strict.mjs`), so new components must not warn under jsdom.

---

## (g) Demo Mode

- Contract (Round 14 SPEC §3.5, `SPEC.md:416-443`): every read with a Demo store reads
  it while Demo Mode is on; every new surface works with no live model; writes to
  Demo-swapped stores land in the Demo store and vanish when Demo ends; writes to real
  stores stay real. "Rule for every writer: a change to real state writes to
  `control_audit`; a change to Demo state writes to the Demo audit ... A test per new
  writer asserts the sink with Demo Mode on and off." The SPEC carries a table of every
  new store and its Demo behaviour; Round 15 should add one.
- Swapping seam `backend/app/state.py:648-736`: `cases`, `audit`, `usage_store`,
  `memory`, `proposals`, `case_threads`, `chat_conversations`, `case_activity`,
  `case_tasks`, `inbox`, `tuning_store`, `campaign_store`, `baseline_store`,
  `batch_job_store`, `shift_handoff`, `pipeline` return the Demo stack's store while
  `self._demo` is set. `control_audit` is always the real audit (auth, RBAC, secrets,
  users, real settings) (`state.py:661-664`); `demo_audit` (`:666-672`) lets the audit
  read API merge Demo human rows with real control rows (D11). `runbook_runs` shows the
  lazy pattern for a store the Demo stack may not build (`state.py:539-556`). The
  `DemoStack` builds its demo-scoped KV stores over its own `EsKVStore` so disabling Demo
  purges them in one step (`demo_runtime.py:230-280`). A new case-adjacent store
  (attachments, review queue) needs both a Demo instance there and a `state.py` property.
- Read-only refusals precedent: `runbook_library` is real and read-only in Demo:
  `409 runbook_demo_readonly` "Runbooks cannot be edited in Demo Mode."
  (`backend/app/engine/runbook_catalog.py:213-214`, `state.py:512-524`); audit exports
  `409 audit_export_demo_mode` (`SPEC.md:436-437`); settings and tuning writes racing a
  Demo toggle answer `409 demo_mode_changed` (`backend/app/audit/settings_write.py:81-115`,
  `routes_tuning.py:56`). An RBAC switch is real state: real prefs, `control_audit`
  (`deps.py:393-395` reads `state.prefs`).
- Seeded data the new surfaces can show without new seeding: the Demo SOC team
  `DEMO_SOC_ANALYSTS = ("asha.iyer", "farhan.qureshi", "meera.pillai")`
  (`backend/app/engine/demo_generator.py:785-795`); an analyst-closed seeded case carries
  `status_history` entries `by=<analyst>` (acknowledge then close) and
  `acknowledged_at` (`demo_generator.py:863-923`); seeded runbook runs write Demo audit
  rows by those analysts (`demo_runbook_audit_rows`, `:1675-1700`; written by
  `seed_demo_runbook_runs`, `:1756-1792`). Seeded human case closes are NOT audit rows,
  so an audit-only activity view would show little seeded close work in Demo; one
  derived from case `status_history` would. Seeding is orchestrated in
  `state.py:3400-3600` (`_enable_demo_unlocked`); attachments or review samples need
  new seed steps there, each wrapped so a failure never blocks enable.
- Demo chat: every starter and case chip is answered by the $0 planner
  (`engine/demo_chat.py`); any new chat question type needs planner support and golden
  rows.
- Webui: `webui/src/soc/demo.tsx` (`useDemo`, `useDemoGuard`, `isDemoActive`); demo
  badges via `DemoBadge`/`DemoIndicator`.
- Screenshots: the docs set uses real WebP captures from the seeded demo
  (`docs/assets/screenshots/`, Journal 2026-11-12), so a new page or Case Manager design
  should show meaningful seeded content in Demo Mode.

---

## (h) Other platform constraints found on the way

- **Upload size.** `webui/nginx.conf:58-67` (`location /api/`) sets no
  `client_max_body_size`, so the bundled nginx refuses bodies over its 1 MiB default with
  413. Screenshot attachments need either an nginx change (shipped in the webui image)
  or client-side downscaling below 1 MiB. `python-multipart==0.0.9` is already a backend
  dependency (`backend/requirements.txt:7`) but no route uses `UploadFile`; the avatar
  precedent is a validated `data:image/(png|webp|jpeg);base64` URL with magic-byte checks
  and a length cap (`backend/app/models.py:624-660`, `PUT /api/me/avatar`
  `routes.py:4763`). `check_version.py:246-252` pins docs/examples boundaries in
  nginx.conf; `test_report_summary_wait.py:26` pins `proxy_read_timeout 300s`.
- **Reset and export.** The cases-tier reset clears listed single-doc KV namespaces
  (`backend/app/engine/reset.py:121-134`) and the multi-doc `runbook_runs` namespace by a
  namespace delete (`reset.py:460-480`); factory reset deletes the whole KV. A new
  case-adjacent namespace (attachments, reviews) must be added to the cases tier. The
  portable export catalog (`backend/app/api/routes_export.py:61`, `_SCOPE_ORDER`;
  `case_runbook_runs` precedent `:746-840`) decides whether new data is exported.
- **Package data.** `recursive-include app *.json *.md` (`backend/MANIFEST.in`) and
  `[tool.setuptools.package-data]` (`backend/pyproject.toml:21-27`) ship new data files;
  the wheel check lists required files (`ci.yml:124-140`).
- **Design gates.** `npm run gates` rejects new arbitrary `text-[N…]` sizes and raw hex in
  `.tsx` against `webui/scripts/grep-baseline.json`; colours come from
  `styles/theme.css` tokens and `components/palette.ts`. No new npm dependency (AGENTS.md §8;
  the only runtime additions since Round 5 are the lazy `motion`).

---

## Risks and decisions for the SPEC

1. **Entry budget is effectively exhausted** (77 B local, ~31 B in CI). A new nav page
   costs ~260 to 330 B standalone or ~120 B as a host tab; wizard copy edits cost or save
   bytes 1:1. Either find bytes first (the 818 B of redundant hidden FEATURES entries is
   the cleanest lever, with one test to repoint) or plan one orchestrator rebase with
   per-file deltas, updating `bundle-first-paint.test.ts` and the record pinned by
   `test_docs_round12_records.py:239-263`.
2. **Nav tests are exact.** A new top-level row changes the collapsed-rail tab order and
   "16th tab stop" test and the console map; a new destination needs a page title that
   equals its nav label (`nav-titles.round14.test.ts`).
3. **Keyword collision with the Audit log** for "activity" / "who did what" in the console
   map and the Round 14 app-help destination tests.
4. **RBAC switch freshness:** the Console reads grants once per refresh; after the switch
   the auth context must refresh, and the switch writes real prefs audited to
   `control_audit` (Demo Mode does not change RBAC).
5. **Demo Mode:** every new store needs a Demo instance or an explicit read-only 409;
   seeded human work lives in case `status_history`, not in audit rows.
6. **Upload limit:** the bundled nginx caps request bodies at 1 MiB.
7. **Records churn:** a new `routes_*.py` changes the router count in AGENTS.md and
   HANDOFF.md (pinned); a Round 15 research folder requires both to name Round 15 newest;
   new audit actions must be added to `event_categories.json` and its webui mirror; a
   new permission must reach `Roles.api.ts`, `permissions.md` and the matrix tests.
