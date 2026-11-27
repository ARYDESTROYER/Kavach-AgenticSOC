# Round 16 research: "What's new" screen and the Communication release tracker

Report key: `whats-new`. Read-only research on branch `claude/round16` (HEAD `3cd362c`, base
`3cfd5c0`). Nothing in the repository was edited.

Operator asks covered here:

- "whenever a new update is delivered, if a user logs in, a first time welcome to that
  update, what's new upfront screen shall be shown"
- "it should be in the communication tab, all changes, well documented and screenshotted
  like a release tracker"
- "this should be the next release" (0.1.13, still untagged; main is at 0.1.12)

## 1. Summary

Build three things, all static content shipped with the Console, with one tiny piece of
per-user state:

1. **A curated, versioned release-notes source in the repo** (`docs/releases/notes/<version>.json`,
   one file per release, each holding dated "updates" with highlights and WebP screenshots),
   validated and compiled by a stdlib Python generator into (a) a JSON file the Console
   imports lazily and (b) a Help Center page. CI checks for drift, as it already does for
   the chat knowledge corpus.
2. **A Communication group in the navigation** (the current "Notifications" group renamed)
   with two pages: **Inbox** (unchanged) and **What's new** (new page id `whats_new`), a
   release tracker that lists every release newest first, with highlights, details, links
   and screenshots.
3. **A "What's new" dialog** shown once per user after an update, keyed by the newest
   release-notes update the user has seen (`UserPrefs.misc.whats_new_seen`), lazy-loaded
   after the shell has painted, dismissible, re-openable from the Communication page, and
   never shown over sign-in, the setup wizard, another dialog or a deep-linked task.

The design adds no dependency, no index, table or migration (one prefs key, plus an
optional small KV document), no model call, and keeps the entry chunk inside its budget
(estimated +250 to +450 B; measure).

Six facts found in the code shape the design (section 2.6): the Docker Web build cannot
see `docs/`; the version does not bump per round on Testing; prefs `ready` is true even
when the prefs read failed; auth-off prefs are one shared bucket; the CHANGELOG already
carries a dated `[0.1.13] - 2026-08-05` heading for a release that will now contain
Rounds 11 to 16; and the docs version helpers live inside the Help Center page chunk.

## 2. What exists today (code facts)

### 2.1 Running version and release identity

- Canonical version: root `VERSION` = `0.1.13`; `webui/package.json` `version` must match
  (`webui/release.config.ts` `resolveBuildReleaseIdentity()` throws on a mismatching
  `TLSOC_VERSION`); `scripts/check_version.py` fails CI on drift, and already requires
  `docs/releases/<VERSION>.md` and a dated `CHANGELOG.md` heading for `VERSION`
  (`check_version.py` lines ~637 to 712).
- Backend identity: `backend/app/build_identity.py` (`build_stamp`, `current_record_provenance`)
  and the public `GET /api/health/build-info` in `backend/app/api/routes.py`
  (`health_build_info`, ~line 407) returning version, channel, commit, build time.
- Console identity: `__TLSOC_RELEASE_IDENTITY__` is injected by Vite `define`
  (`webui/vite.config.ts` ~line 269), normalized in `webui/src/lib/release.ts`
  (`CONSOLE_RELEASE_IDENTITY`, `resolveReleasePresentation`; any mismatch downgrades to Testing).
- `/release.json` is emitted by `releaseManifestPlugin()` in `webui/vite.config.ts` and
  served no-store by `webui/nginx.conf`; it exists to activate an already-deployed coherent
  pair (`webui/src/lib/deployment-update.ts`), not to describe content.
- The shell badge: `ReleaseBadge` in `webui/src/soc/AppShell.tsx` (~line 559), a Popover
  with Console and backend build rows. This is the natural second entry point
  ("What's new in v0.1.13" link).
- Semver compare exists but is private: `semanticVersion` / `compareVersions` in
  `webui/src/lib/upstream-release.ts`.

### 2.2 Per-user preferences

- `backend/app/stores/user_prefs.py` `UserPrefsStore`: one KV document
  (`ns=user_prefs`, `key=buckets`) holding every user's bucket, CAS-safe via `kv_mutate`;
  `patch()` deep-merges `misc`. No new index or table needed (#12).
- `backend/app/models.py` `UserPrefs.misc` is normalized on load by `_misc_chat_stream_mode`;
  Round 14 added the precedent `_ROUND14_LIST_PREFS` (`dashboards_hidden`,
  `dismissed_intros`, id grammar `^[a-z0-9][a-z0-9_.:-]{0,63}$`).
- `backend/app/api/routes_prefs.py` `prefs_user_put` audits changes to
  `_AUDITED_MISC_KEYS` before saving (`user.preferences_updated`, audit-first, `503` on an
  audit failure).
- Console: `webui/src/soc/prefs.tsx` `PrefsProvider` exposes `prefs.misc`, `ready` and an
  optimistic `patchMisc()`. The Round 14 `Callout intro` (`webui/src/design-system/callout.tsx`)
  is the "dismissed once, remembered per user" precedent.

### 2.3 Navigation

- `webui/src/soc/registry.tsx` `FEATURES[]` is the single registry for rail, palette, router
  and breadcrumb; `ROUTES` maps each `PageId` to a `React.lazy` page.
- The Notifications group today is one row whose only child is its own page:
  `{ id: 'inbox', label: 'Notifications', group: 'notifications', children: [{ id: 'inbox', label: 'Inbox' }] }`.
  `NavSidebar.tsx` `toDestinations()` draws a single-child group as a plain row; with two
  children it becomes a disclosure automatically.
- There is no "Communication" page or group anywhere in `webui/src`, `backend/app` or `docs`.
- Adding a page touches (from the Round 15 Team activity commit `5072c1e`): `registry.tsx`
  (PageId union, FEATURES, ROUTES), `__tests__/route-registry.test.tsx`,
  `__tests__/nav.behaviour.test.tsx`, `__tests__/nav-titles.round14.test.ts`,
  `__tests__/route-visual-standard.test.ts` (PRIMARY_SURFACES),
  `__tests__/console-map.contract.test.ts` (keywords) then `npm run gen:console-map`
  (writes `backend/app/knowledge/console_map.json`), then `scripts/build_app_knowledge.py`.

### 2.4 Help Center and screenshots

- `scripts/build_docs_bundle.py` builds MkDocs (strict) into `webui/public/docs/<major.minor>/`
  with `manifest.json`; nginx serves `^~ /docs/` as static files (`webui/nginx.conf`).
  Every non-Markdown file under `docs/` is copied, so `docs/assets/releases/0.1.13/x.webp`
  is served at `/docs/0.1/assets/releases/0.1.13/x.webp`.
- Existing screenshots: `docs/assets/screenshots/*.webp`, 25 files, all 2880 x 1800
  (1440 x 900 at 2x), 31 KB to 247 KB, VP8X WebP; alt text in the docs is long and
  descriptive; light/dark pairs use MkDocs `#only-light` / `#only-dark`
  (`docs/getting-started/quickstart.md` line 107).
- They were captured with `playwright-core` installed outside the repo, Chromium at
  `/opt/pw-browsers`, against `scripts/run-demo.sh` in Demo Mode (Journal entry near
  line 11119). ImageMagick `convert` is present in the sandbox; Chromium's CDP
  `Page.captureScreenshot` also supports `format: "webp"`.
- `webui/src/soc/pages/Docs.tsx` holds `docsVersionLine()` and `docsArticleUrl()`; they are
  exported from a page module, so importing them elsewhere would pull the Help Center page
  into that chunk.
- `scripts/build_app_knowledge.py` builds the $0 chat product-help corpus from public nav
  pages; `GUIDE_EXACT` / `OPERATE_EXACT_BASE` decide which pages enter; historical release
  records are excluded except `releases/<VERSION>.md`.

### 2.5 Release records

- `docs/releases/0.1.13.md` and `CHANGELOG.md [0.1.13] - 2026-08-05` describe only the
  legacy-bootstrap identity fix. All of Round 11 (merged 2026-08-24), the Overview and
  Case Manager redesign (2026-10-06), the chat revamp (2026-10-09), Round 12 (2026-10-12),
  Round 13 (2026-10-24), Round 14 (2026-11-06, follow-up 2026-11-11), the docs rewrite
  (2026-11-13) and Round 15 (2026-11-25) sit under `[Unreleased]` with "the version stays
  0.1.13" (dates from `git log --first-parent`).
- Tags: `v0.1.1` (2026-07-31, the last verified installable Stable), `v0.1.4` to `v0.1.12`
  (failed or bootstrap-blocked publications, all 2026-08-05). `v0.1.13` does not exist.
- The existing release pages are operator and supply-chain records (signed plans, digests,
  bootstrap), not analyst-facing notes. A user-facing source is needed.

### 2.6 Constraints and latent problems found while reading

| # | Finding | Evidence | Consequence for this feature |
|---|---|---|---|
| F1 | The Docker Web build stage copies only `webui/` (plus the built docs artifact into `public/docs`). | `webui/Dockerfile`: `COPY webui/ ./` then `COPY --from=docs /artifact/docs ./public/docs` | A Console `import` from `../docs/...` breaks the image build. The generated notes JSON must be checked in under `webui/src`, or the Dockerfile must copy it (a CI-contract change). Prefer the checked-in generated file. |
| F2 | The version does not bump per round on Testing (Rounds 12 to 15 all ran as 0.1.13). | CHANGELOG `[Unreleased]`, Round 15 bullet "the version stays 0.1.13" | A marker keyed by version alone would never re-show on Testing after the first build of a version. Key the marker by the newest **update id** instead. |
| F3 | `PrefsProvider.ready` becomes true even when `GET /api/prefs/effective` failed (it falls back to empty `misc`). | `webui/src/soc/prefs.tsx` `refresh()` | An empty `misc` is ambiguous. The gate must not read "no marker" as "never seen" after a failed read, or the dialog reappears whenever prefs fail. Expose a `loaded` flag or have the lazy host read its own endpoint. |
| F4 | With auth off every caller shares the `default` prefs bucket. | `routes_prefs._prefs_user_id`, `user_prefs.normalize_user_id` | In the no-auth profile What's new is once per installation, not per person. Document it. |
| F5 | `CHANGELOG.md` already has a dated `[0.1.13] - 2026-08-05` heading and `docs/releases/0.1.13.md` covers only the bootstrap fix, while the next 0.1.13 release will contain Rounds 11 to 16. | CHANGELOG line 2360; `docs/releases/0.1.13.md` | Release prep must re-date and expand both; the What's new entry date must be the real release date, never 2026-08-05. |
| F6 | `docsVersionLine` / `docsArticleUrl` live in `pages/Docs.tsx`. | `Docs.tsx` line 327 | Move them to a small `lib/docs-url.ts` so the What's new chunk does not pull the Help Center page. |

## 3. External research

### 3.1 Patterns observed

- **Two surfaces: a curated "What's new" for highlights and a full, dated log.** Figma's
  release notes page is a dated, filterable, paginated log, newest first, with a type label
  ("New release", "Update"), product-area tags, a "Copy link" per entry and an RSS feed
  [Figma]. A template vendor describes Figma as splitting user-facing "What's new" from
  detailed "Release notes" [Released.so, secondary, not verified on Figma's own pages].
  GitHub categorizes every changelog post as "new release, improvements, or retired",
  offers 12 curated product-area tags as filters, and groups posts by month and archives
  by year [GitHub changelog].
- **In-app entry point with an unread indicator.** Linear put links to the latest
  changelog posts in the app sidebar and turns the indicator purple "when there are new
  updates" [Linear 2020]. Raycast once had a "See What's New" root-search item and changed
  it to "auto-dismiss after one day" [Raycast changelog v1.74]; whether Raycast opens a
  window automatically after every update could not be verified.
- **Notion and Slack** publish "What's New" / release-notes pages on the web
  [Notion releases] [Slack release notes]; their exact in-app menu locations could not be
  verified from public sources.
- **Vercel** runs a long timeline of entries with screenshots and author bylines, readable
  from the CLI (`vercel changelog`, `--json`) [Vercel CLI changelog]; the page layout
  description comes from a third-party teardown [SaaSFrame, secondary].

### 3.2 Announcement guidance

- Match intensity to significance: a modal after login suits "a major release affecting
  all users"; frequent full-screen takeovers "harm the overall user experience"
  [Appcues UI patterns]. Release notes and "what's new" panels fit routine updates that
  users open on demand [Appcues, synthesized in search results].
- Keep it short: "What it is, why they should care, one clear call-to-action", "Show,
  don't tell: include a screenshot", segment "by plan level, user role, or previous
  behavior", and expire launch messages after "7-14 days maximum" [Customer.io].
- Announce to people who can use the feature, in context, when they are "inside your
  product and in a position to use it"; prioritize, use visuals, focus on the most
  important job [Intercom guide].
- Do not interrupt: "Do not use modal dialogs for nonessential information that is not
  related to the current user flow", unrequested modals are "perceived as annoying",
  avoid interrupting high-stakes flows [NN/g]. This is why the dialog must not open over
  a deep-linked task (an analyst arriving from an alert link) and must stay short.
- Write for humans, newest first, one entry per version, dated, linkable, grouped by type
  (Added, Changed, Deprecated, Removed, Fixed, Security); commit logs are "a bad idea"
  as changelogs [Keep a Changelog 1.1.0]. The repo's CHANGELOG already follows it.

### 3.3 Accessibility

- WAI-ARIA APG modal dialog: `role="dialog"`, `aria-modal="true"`, a name via
  `aria-labelledby`; Tab and Shift+Tab wrap inside; Escape closes. For large content,
  focus a static element at the top (`tabindex="-1"` on the title) instead of the first
  control. On close, focus returns to the invoker, or, when there is none, "to another
  element that provides logical work flow" [APG]. Radix Dialog (`webui/src/ui/dialog.tsx`)
  provides the role, modal state, trap and Escape; `onOpenAutoFocus` / `onCloseAutoFocus`
  cover the two focus rules. An auto-opened dialog has no invoker, so close focus goes to
  `#socMain`, the pattern `AppShell.navigateFromDesktop` already uses.
- `aria-describedby` should be omitted when the content holds lists or several paragraphs
  [APG]; describe only the one-sentence summary.
- WCAG 2.2 SC 2.2.4 Interruptions (AAA): "Interruptions can be postponed or suppressed by
  the user" [W3C 2.2.4]. A personal "Show What's new after updates" switch meets it.
- WCAG 2.2 SC 2.3.3 Animation from Interactions (AAA) with technique C39
  `prefers-reduced-motion` [W3C 2.3.3]; the Console already neutralizes CSS motion under
  that query (`styles/theme.css`) and no extra animation is needed.
- Images: give every `<img>` `width` and `height` to avoid layout shift; do not lazy-load
  in-viewport images; `display: none` images are not fetched [web.dev lazy loading].

## 4. Proposed design

```
docs/releases/notes/<version>.json   (curated source, one per release)
docs/assets/releases/<version>/*.webp (screenshots, light and optional dark)
        |
        |  scripts/build_release_notes.py  (stdlib; --check in CI)
        v
webui/src/soc/whats-new/release-notes.gen.json   (checked in, lazy-imported)
docs/releases/whats-new.md                       (checked in, Help Center page)
        |
        |  Vite define __TLSOC_WHATS_NEW_LATEST__ = newest update id (a few bytes in entry)
        v
Entry: tiny gate in Boot (prefs loaded, shell shown, idle)  --marker == latest?--> stop
        |  else import('./whats-new/WhatsNewHost') (retryingLoader)
        v
Lazy host: GET /api/whats-new (eligibility) -> show dialog or stamp silently
Communication > What's new page (#/whats_new): the full tracker, same JSON
```

### 4.1 Data model (curated source)

One file per release, `docs/releases/notes/0.1.13.json`:

```json
{
  "schema": 1,
  "version": "0.1.13",
  "status": "released",
  "date": "2026-12-01",
  "title": "Explainable numbers, a cleaner Case Manager and What's new",
  "summary": "Everything since 0.1.1 in one Stable release.",
  "docs": "releases/0.1.13/",
  "updates": [
    {
      "id": "0.1.13.2026-12-01",
      "date": "2026-12-01",
      "title": "What's new, explainable numbers and a cleaner Case Manager",
      "highlights": [
        {
          "id": "explain-numbers",
          "kind": "new",
          "area": "cases",
          "title": "Every number explains itself",
          "summary": "Hover or press a risk score to see its inputs and the exact sum.",
          "details": ["The risk popover lists each factor, its weight and the total."],
          "featured": true,
          "requires": "cases:read",
          "open": { "page": "case_manager" },
          "help": "analyst/case-manager/",
          "screenshot": {
            "light": "explain-risk-light.webp",
            "dark": "explain-risk-dark.webp",
            "alt": "Case Manager with the risk score popover open, listing ...",
            "caption": "The risk score popover"
          }
        }
      ]
    }
  ]
}
```

Rules the generator enforces (all stdlib):

- `version` is SemVer and equals the file name; `status` is `released` (needs `date`) or
  `testing` (allowed only for the current `VERSION`, and never on `main`, see R10).
- `updates[]` newest first, each `id` unique across all files and in the
  `dismissed_intros` id grammar (`^[a-z0-9][a-z0-9_.:-]{0,63}$`), dates non-increasing;
  across files, versions strictly decreasing in output order.
- `kind` in {`new`, `improved`, `fixed`, `removed`, `security`} (Keep a Changelog types);
  `area` in a closed list (`cases`, `chat`, `dashboards`, `detection`, `intelligence`,
  `automation`, `security`, `administration`, `platform`, `help`).
- Plain text only: reject `<`, `>`, raw URLs and Markdown links; allow only `**bold**` and
  `` `code` `` (what `webui/src/soc/components/Markdown.tsx` renders, HTML-injection-safe).
  Length bounds: title 80, summary 200, each detail 280, at most 12 details, at most 8
  featured highlights per update.
- `open.page` must be a page id in `backend/app/knowledge/console_map.json` (generated from
  the registry, so the Python side can validate Console routes without reading TypeScript);
  `requires` uses the console map's `resource:action` form; `help` must resolve to a public
  docs page.
- Screenshots: file exists under `docs/assets/releases/<version>/` (or reuses
  `docs/assets/screenshots/`), is WebP (RIFF/WEBP magic), width and height read from the
  VP8/VP8L/VP8X header and copied into the output, at most 2880 px wide and 250 KB;
  `alt` is required (at least 40 characters, no "image of"); a `featured` highlight needs
  both `light` and `dark`.
- No hidden characters (reuse `check_docs.hidden_characters`) and no em dashes in public
  copy (house style seen in Journal "no banned characters").

### 4.2 Show rule (one per user, keyed by update id)

Marker: `UserPrefs.misc.whats_new_seen` = id of the newest update the user has seen
(string, the dismissed-intro grammar; normalized on load, removed when invalid).

| Marker state | Server eligibility (`GET /api/whats-new`, R5) | Result |
|---|---|---|
| equals the newest bundled update id | not called | nothing (entry check only, no chunk, no request) |
| an older bundled id | not needed | dialog with the unseen updates newer than it (newest first, featured highlights, at most 6, "See all changes (N)") |
| unknown id (written by a newer build, then rolled back) | not needed | nothing (treat as seen everything) |
| absent, fresh install (setup not complete when this version first ran) | `upgraded: false` | stamp silently, no dialog |
| absent, account created after this version first ran | `account_new: true` | stamp silently, no dialog |
| absent, existing account on an upgraded install | `upgraded: true, account_new: false` | "Welcome to 0.1.13" dialog with the current version's featured highlights only |
| absent, endpoint unavailable (R5 not built, or error) | none | "Welcome to <version>" dialog (fail toward informing; it is dismissible) |
| personal switch off (`misc.whats_new_auto === false`) | not called | nothing; the page still marks "New" items |

Additional conditions (all must hold before opening): signed in (or auth off), setup
complete and not forced into the wizard, prefs **loaded** (F3), the routed page has
rendered, no other dialog is open (`[role=dialog][data-state=open]`, the command palette,
ReauthDialog, the supervised update progress), and the session did not start on a deep
link to a record (`case_manager` / `cases` with a `caseId`, a rule sheet, a report). In the
deep-link case the gate waits for the next navigation to a landing page in that session,
else the next load. Any close (Got it, Escape, outside click, See all changes, Open on a
highlight) writes the marker; a failed write is mirrored in `localStorage`
(`tlsoc_whats_new_seen:<user>`, try/catch) so the same browser does not nag.

### 4.3 Dialog design ("super clean")

- Radix `Dialog`, 40rem wide (the lifecycle dialog width in `ui-standard.md`), 14 px radius,
  `shadow-overlay`, shared scrim, footer pinned; below 640 px it fills the screen.
- Header: eyebrow "What's new · v0.1.13 · 1 Dec 2026" (plus "Testing" when the channel is
  Testing), title `DialogTitle` "Welcome to Agentic SOC 0.1.13" with `tabIndex={-1}` and
  initial focus, one-sentence summary as the description.
- One hero figure: the selected featured highlight's screenshot in the current theme
  (`useTheme().isDark` picks `dark` when present), 16:10, border, explicit width and height,
  `decoding="async"`, eager (it is in view), caption below. Press to enlarge in a small
  lightbox (a generic one; the case-files `Lightbox` fetches blobs and is not reusable).
- Up to 5 highlight rows: area icon tile, title, one-line summary; pressing a row selects it
  for the hero (`aria-pressed`, no carousel, no autoplay); "Open" is a sibling link shown
  only when the viewer may open that page.
- Footer: "See all changes" (navigates to `#/whats_new?v=0.1.13`) and primary "Got it".
- No confetti, no progress dots. Motion is the existing dialog zoom; reduced motion
  removes it.

### 4.4 Communication page ("release tracker")

- Route `#/whats_new`, `PageId 'whats_new'`, label "What's new", a child of the renamed
  group row; page file `webui/src/soc/pages/WhatsNew.tsx` (lazy) with `PageContainer` and
  `PageHeader` (help tip: "Every Agentic SOC release with highlights, details and
  screenshots. These notes ship with this installation.").
- Header actions: muted release line ("Running v0.1.13 · Testing", reusing
  `resolveReleasePresentation`), a search field, and the personal switch "Show after
  updates".
- From 1280 px: a sticky 240 px version rail (version, date, Stable or Testing chip,
  "Installed here" on the running version, "Installed 24 Nov" when R5 history exists);
  below 1280 px a version select.
- Main column: release title, date and summary, links to the Help Center release record
  and upgrade notes; area filter chips (All plus the areas present); updates grouped by
  date ("25 Nov 2026 · Team activity, case screenshots and a calmer Case Manager"); each
  highlight is a divider-led row with a kind chip (New, Improved, Fixed, Removed,
  Security), title, summary, details (via `Markdown`), figure (first one eager, the rest
  `loading="lazy"`), and actions Open, Read more (Help Center), Copy link
  (`#/whats_new?v=0.1.13&h=explain-numbers`). "New" badges mark items newer than the
  marker the user had when the page opened.
- A collapsed group "Earlier release records" lists 0.1.2 to 0.1.12 as one line each
  ("Release engineering record. Not installable; superseded by 0.1.13.") linking to the
  existing Help Center pages, so "all changes" stays honest without padding the tracker.
- A broken or missing image (no docs bundle in `npm run dev` without `docs:bundle`, or a
  partial deploy) collapses to its caption via `onError`.

## 5. Recommendations

Each recommendation lists what, where, effort (S/M/L), value, risks and tests.

### R1. Curated release-notes source and generator (M, high, this round)

- What: `docs/releases/notes/<version>.json` per release (schema in 4.1), screenshots in
  `docs/assets/releases/<version>/`, and `scripts/build_release_notes.py` (stdlib only,
  modeled on `scripts/build_app_knowledge.py`) that validates every file, then writes
  `webui/src/soc/whats-new/release-notes.gen.json` (sorted, compact, image dimensions
  included) and `docs/releases/whats-new.md` (one Help Center page: every release, newest
  first, with `#only-light` / `#only-dark` figures). `--check` fails on drift.
- Where: new script; `mkdocs.yml` nav "Releases and versions" gains
  `What's new: releases/whats-new.md` as its first item; `.github/workflows/ci.yml` docs
  lane gains `python scripts/build_release_notes.py --check` and
  `python scripts/test_build_release_notes.py` (and `scripts/check_ci_contract.py` if it
  pins lane steps).
- Why the generated JSON is checked in under `webui/src`: F1 (the Docker Web stage cannot
  see `docs/`). This mirrors `webui/src/lib/api-types.gen.ts`.
- Risks: two generated artifacts to keep current (mitigated by `--check`); authors writing
  long prose in JSON (keep highlights short by design; the long form stays in
  `docs/releases/<version>.md`).
- Tests: `scripts/test_build_release_notes.py`: a valid fixture passes; each rule has a
  rejecting fixture (bad SemVer, file-name mismatch, duplicate update id, out-of-order
  dates, unknown area or kind, unknown `open.page`, missing or non-WebP screenshot,
  oversize image, wrong dimensions, missing alt, featured without dark, `<` or a raw URL
  in text, hidden character); `--check` reports drift after a one-character edit.

### R2. Communication group and the What's new page (M, high, this round)

- What: rename the group label "Notifications" to "Communication"
  (`FEATURE_GROUPS` and the `inbox` row label), give the row two children
  `[{ id: 'inbox', label: 'Inbox' }, { id: 'whats_new', label: "What's new" }]`, add
  `'whats_new'` to the `PageId` union and `ROUTES` (`React.lazy(() => import('./pages/WhatsNew'))`),
  no `perm` (like the Help Center). Build the page per 4.4.
- Where: `webui/src/soc/registry.tsx`; new `webui/src/soc/pages/WhatsNew.tsx` and
  `webui/src/soc/whats-new/*` (notes loader, `ReleaseRail`, `HighlightRow`,
  `ReleaseFigure`, `ImageLightbox`); move `docsVersionLine` / `docsArticleUrl` to
  `webui/src/lib/docs-url.ts` (F6) and re-export from `Docs.tsx`; export the semver helpers
  from `upstream-release.ts` into `webui/src/lib/semver.ts`. Keep the top-bar bell named
  "Notifications".
- Docs and knowledge: `docs/USAGE.md` lines 65 and 1953 ("Notifications" group),
  `console-map.contract.test.ts` keywords for `whats_new` ("what's new", "release notes",
  "changelog", "updates", "new features"), `npm run gen:console-map`, then
  `scripts/build_app_knowledge.py`; add `releases/whats-new.md` to `GUIDE_EXACT` so chat's
  $0 product help can answer "what changed in this version" (#6 unaffected: no model call).
  Add a "What's new" article to `DOC_CATEGORIES` in `Docs.tsx` (reference category).
- Risks: renaming a group moves the console-map crumb ("Notifications > Inbox" becomes
  "Communication > Inbox"), which chat answers and docs quote; regenerate both in the same
  change. The operator's word is "Communication tab"; confirm it should replace the
  "Notifications" label rather than sit beside it.
- Tests: `route-registry.test.tsx` (every PageId resolves), `nav.behaviour.test.tsx`
  (Communication disclosure with two children; Inbox still opens `#/inbox`),
  `nav-titles.round14.test.ts` (`whats_new` page title "What's new"),
  `route-visual-standard.test.ts` (add `soc/pages/WhatsNew.tsx` to PRIMARY_SURFACES),
  console-map contract; a page test: newest first, version rail selection and
  `?v=&h=` deep link scroll and focus, area filter, search, "New" badges from a given
  marker, Open hidden without the grant (RBAC on) and shown with RBAC off, image `onError`
  fallback, first figure eager and the rest lazy with width and height set, jest-axe clean
  in both themes.

### R3. Per-user marker in prefs (S, high, this round)

- What: `misc.whats_new_seen` (string, dismissed-intro grammar) and `misc.whats_new_auto`
  (bool, absent means on), normalized on load in `UserPrefs` like `_ROUND14_LIST_PREFS`
  (invalid removed, never coerced); add `whats_new_seen` to `_AUDITED_MISC_KEYS` so an
  acknowledgement is an audited `user.preferences_updated` row with before and after
  (useful evidence that users were informed of changes; volume is one row per user per
  update).
- Where: `backend/app/models.py` (new constants beside `DISMISSED_INTROS_PREF_KEY`),
  `backend/app/api/routes_prefs.py` `_AUDITED_MISC_KEYS`; Console types in
  `webui/src/lib/types.ts`; expose a `loaded` flag (fetch succeeded) from
  `webui/src/soc/prefs.tsx` for F3.
- Risks: audit-first means an audit outage answers `503` and the marker is not stored; the
  `localStorage` mirror prevents repeats in that browser. Auth-off shares one bucket (F4).
- Tests: backend normalizer (valid kept, invalid string, number and list removed, other
  misc keys untouched); `PUT /api/prefs/user` with the key writes one audit row first and
  a failed append returns `503` with nothing saved; a no-op resend writes no row. Console:
  `loaded` is false after a failed prefs read.

### R4. Lazy "What's new" dialog and entry gate (M, high, this round)

- What: a tiny gate in `Boot` (`webui/src/soc/App.tsx`, next to `<ReauthDialog>`), so it
  mounts only when the shell renders: when `prefs.loaded`, `misc.whats_new_auto !== false`
  and `misc.whats_new_seen !== __TLSOC_WHATS_NEW_LATEST__`, schedule
  `requestIdleCallback` (timeout about 3 s, `setTimeout` fallback) and load
  `./whats-new/WhatsNewHost` through `retryingLoader` (`webui/src/soc/lazy-retry.ts`). The
  host applies the 4.2 table and renders the 4.3 dialog. Inject
  `__TLSOC_WHATS_NEW_LATEST__` with Vite `define` in `webui/vite.config.ts` by reading the
  generated JSON at build time (declare it in `webui/src/vite-env.d.ts`). Stamp the marker
  silently on wizard completion (`Wizard onComplete` in `App.tsx`).
- Re-open: the Communication page header button "Show the welcome screen", and a
  "What's new in v0.1.13" link in the `ReleaseBadge` popover (`AppShell.tsx`), both opening
  the same host with `force`.
- Accessibility: initial focus on the title (`tabIndex={-1}`, `onOpenAutoFocus`), close
  focus to `#socMain` (`onCloseAutoFocus`), description limited to the summary sentence,
  figure alt from the notes, rows as buttons with `aria-pressed`, Open as links, all text
  plain (#9 not at stake: the notes are trusted repo content, but plain text keeps the
  renderer safe anyway).
- Risks: interrupting work (handled by the deep-link deferral and the "no other dialog"
  rule); two tabs opened at once both show it (optional `BroadcastChannel` close, S);
  showing during the Round 16 login animation (the gate waits for the shell, so it lands
  after the login transition).
- Tests: a pure `decideWhatsNew(marker, notes, eligibility, context)` function with a case
  per row of the 4.2 table; the gate loads no chunk when the marker equals the latest id;
  it never mounts on Login, the forced password change, the wizard or while ReauthDialog
  is open; deep link deferral then open on the next landing navigation; Escape, outside
  click, Got it and See all changes each write the marker once; focus lands on the title
  and returns to `#socMain`; a failed chunk import or failed write leaves the shell
  unaffected and no error toast; jest-axe on the open dialog; 390 px width snapshot.

### R5. Server eligibility and install history (S to M, medium, this round if time)

- What: a small KV document `ns=release_history`, `key=installs` (strict CAS through
  `kv_mutate`), holding at most 100 `{version, first_seen_at, upgraded}` rows; written once
  per new `__version__` in `AppState.startup()` after `config_store.load()` (skipped in the
  factory-recovery branch), where `upgraded` is `prefs.setup_complete` at that moment. A
  route module `backend/app/api/routes_whats_new.py` (auto-discovered by
  `discover_feature_routers()`) serves `GET /api/whats-new` (auth required, self-scoped, no
  permission, no audit, 60 s cache per caller like the starters route) returning
  `{seen, running_version, first_seen_at, upgraded, account_new, installed: [...]}`;
  `account_new` compares the user's `created_at` (`state.users.get`) with `first_seen_at`.
- Value: suppresses the welcome for accounts created after the update and for fresh
  installs (including accounts an admin creates later), and gives the tracker its
  "Installed here on" dates. Without it, R4 still works with the fail-toward-informing row.
- Risks: a new KV namespace is purged by the factory reset (`app_state.kv.factory_purge_strict()`
  in `engine/reset.py`), which is correct: after a factory reset the next boot of the same
  version is not recorded again until restart, so also record lazily on the first
  `GET /api/whats-new` when the document is empty (with `upgraded = setup_complete`).
  Single-replica only, as the rest of the app.
- Tests: boot records once and is idempotent; a second version appends; the cap holds; the
  factory-recovery boot writes nothing; lazy record after a purge; `account_new` true and
  false around `first_seen_at`; auth off returns `account_new: null`; route auth coverage
  (`test_route_auth_coverage`), OpenAPI and `npm run gen:types` then `check:types` without
  drift.

### R6. Personal switch for interruptions (S, medium, this round)

- What: "Show What's new after updates" (`misc.whats_new_auto`) in the What's new page
  header and in Settings, personal section (the Appearance or Notifications group in
  `webui/src/soc/pages/settings/*`). Meets WCAG 2.2.4 (AAA).
- Tests: off means the gate makes no request and loads no chunk; the page still shows
  "New" badges.

### R7. Backfill content for 0.1.13 (Rounds 11 to 16) and 0.1.1 (M, high, this round)

See section 6. Writing plus capture is most of the effort; reuse the existing 2880 x 1800
WebP set where it still matches the current UI.

- Risks: screenshots that predate Round 16 visual changes (Case Manager, login) must be
  recaptured after those land; capture last, from seeded Demo, both themes for featured
  highlights.
- Tests: R1 validation; a docs-records test in the style of
  `backend/tests/test_docs_round15_records.py` that reads facts from code (for example, that
  every `open.page` exists and that the featured highlights of the current version name
  pages the default roles can open).

### R8. Entry-bundle discipline (S, high, this round)

- What: only the gate (marker compare plus one dynamic import thunk), the registry row and
  route thunk, the `define` string and one new lucide icon (for example `Sparkles` for the
  child; keep `Bell` for the group) reach the entry. Estimate +250 to +450 B (unmeasured;
  measure with `npm run build:app`). The page, dialog, notes JSON, lightbox and figure code
  are lazy chunks.
- Where: `webui/src/soc/__tests__/bundle-first-paint.test.ts` budget (329,080 B baseline,
  +1,024 B). Other Round 16 entry changes (the AI-investigating indicator, the login work)
  share the same 1,024 B, so coordinate.
- Tests: the existing budget test; add assertions that the entry does not contain a unique
  notes string (a highlight title) or the dialog's title text, and that a lazy
  `WhatsNew-*.js` chunk exists.

### R9. Demo Mode and RBAC behaviour (S, high, this round)

- Demo Mode: the dialog and page behave as in a live install (static content; prefs are
  real, not Demo-swapped; the marker write is allowed in Demo like `dismissed_intros`).
  Screenshots are captured only from `scripts/run-demo.sh` seeded data, never a live
  install. `run-demo.sh` (Admin / Admin@123, setup complete, no marker) therefore shows the
  welcome on first sign-in, which is the desired showcase.
- RBAC: the page and `GET /api/whats-new` need only a signed-in session; the content is
  public (it ships in the bundle). Each highlight may carry `requires`; the Console uses the
  same `featureEnabled` / `hasPermission` check as the rail to (a) hide Open for a viewer
  without the grant and (b) drop that highlight from the dialog's featured list (it stays
  on the page). With RBAC off every highlight is usable. With auth off the marker is per
  installation (F4).
- Tests: as in R2 and R4 (Open visibility per grant, featured filtering per role, auth-off
  single bucket).

### R10. Release-prep gate: every release ships notes (S, high, this round)

- What: `scripts/check_version.py` also requires `docs/releases/notes/<VERSION>.json`;
  on `main` and on tags its `status` must be `released` with a `date` equal to the dated
  CHANGELOG heading. Add the step to `docs/releases/channels.md` (release checklist).
- Risk: F5. The existing `[0.1.13] - 2026-08-05` heading must be re-dated and expanded to
  cover Rounds 11 to 16 in the release-prep change, and `docs/releases/0.1.13.md` must gain
  a user-facing summary that links to the What's new page.
- Tests: `check_version` unit cases: missing notes fails; `testing` status on a release
  ref fails; date mismatch fails.

### R11. Optional polish (S, low to medium, this round only if the budget allows)

- An unread dot on the Communication row while unseen updates exist (Linear pattern),
  driven by a tiny store the gate sets; costs entry bytes.
- `BroadcastChannel('tlsoc-whats-new')` so dismissing in one tab closes it in others.
- An Atom feed generated next to `docs/releases/whats-new.md` for the public GitHub Pages
  docs (Figma and GitHub offer feeds); low value for self-hosters.

### R12. Later, not this round: organization announcements (L, medium)

An admin-authored, audited broadcast ("Maintenance tonight at 18:00") in the
Communication group, stored in KV, plain text only (#9, bounded like `BrandingConfig`),
shown as a banner until dismissed. It fits the "Communication" name but the operator did
not ask for it.

## 6. Backfill plan (0.1.13 and earlier)

The next release, 0.1.13, is the first installable Stable since 0.1.1, so its notes cover
everything users get when moving from 0.1.1. Group them as dated updates (GitHub's
monthly grouping), newest first; Console copy never says "Round". Each row names its source
records and screenshot reuse.

| Update id (proposal) | Date | Title | Featured highlights (dialog) | Other highlights (page) | Sources | Screenshots |
|---|---|---|---|---|---|---|
| `0.1.13.2026-12` | release date | What's new, explainable numbers, a cleaner Case Manager | Explainable numbers (risk score math on hover/press); cleaner Case Manager; AI investigating indicator; What's new and Communication | Cleaner sign-in and "Remember me" without a duration; bug fixes from the Round 16 hunt | Round 16 SPEC (to be written) | New captures after the work lands (light and dark) |
| `0.1.13.2026-11-25` | 2026-11-25 | Team activity, case screenshots and a calmer Case Manager | Team activity; screenshots on cases; auto-close review | Role-based access switch (admins); truthful setup wording; stronger close; Super admin accounts | CHANGELOG `### Round 15`; `docs/research/2026-11-round15/SPEC.md` §8 | Reuse `case-manager.webp`, `users-rbac.webp`, `install-05-setup-ai-runtime.webp`; new: team activity, files gallery, review card |
| `0.1.13.2026-11-06` | 2026-11-06 | Dashboards library, a usable audit log, rule sheets and Runbooks | Dashboards library; Audit log; Runbooks (one feature) | Rule sheet from any rule name; named severity levels; docked navigation; grouped Settings; sign-out notice wording; chat capacity tripled | CHANGELOG `### Round 14`, follow-up fixes; Round 14 SPEC §11 | Reuse `dashboards-library.webp`, `audit-log.webp`, `runbooks.webp`; new: rule sheet |
| `0.1.13.2026-10-24` | 2026-10-24 | Suggested questions and a neater chat | Suggested questions from your data | Follow-up chips; conversation titles; reading column | CHANGELOG "Earlier rounds" Round 13; SPEC-chat §10 | Reuse `workspace-chat.webp` if current; new: start screen |
| `0.1.13.2026-10-12` | 2026-10-12 | Chat without limits, Remember me and report downloads | Chat without per-question caps; working indicator and rejoin; Remember me | Report downloads (Word, Excel); Overview and Case Manager redesigns; analyst-classification headline | CHANGELOG Round 12; Round 12 SPEC | New: working indicator, report export |
| `0.1.13.2026-10-09` | 2026-10-09 | A read-only analyst assistant | Workspace chat with blocks, citations and reports | Live token meter | Chat revamp SPEC | Reuse `workspace-chat.webp` |
| `0.1.13.2026-08-24` | 2026-08-24 | Cyber Defence Center and mandated MFA | Cyber Defence Center with trendlines; admin-mandated MFA | Richer user creation; 38 enrichment providers with setup guides; scannable TOTP QR | AGENTS §10 Round 11; Journal 2026-08-22 | Reuse `hero-overview-light.webp` / `-dark.webp`, `users-add-user.webp` |
| `0.1.13.2026-08-05` | 2026-08-05 | Signed, supervised Stable updates (administrators) | none (admin-only) | Signed update plan and rollback-capable supervisor; legacy bootstrap fix | `docs/releases/0.1.4.md` to `0.1.13.md`; CHANGELOG `[0.1.4]` to `[0.1.13]` | none |
| `0.1.1` entry | 2026-07-31 | The 0.1 line | not shown in the dialog | What 0.1 provides (sources, OCSF, two-tier investigation, deterministic decisions, audit, cost ledger) | `docs/releases/0.1.md` "What 0.1 provides" | Reuse `hero-overview-*.webp`, `sources.webp` |
| Earlier records | 2026-08-03 to 2026-08-05 | 0.1.2 to 0.1.12 | not shown | one line each, linking to the Help Center record | `docs/releases/0.1.2.md` to `0.1.12.md` | none |

Capture procedure (fits the sandbox): run `scripts/run-demo.sh` (auth on, seeded Demo),
drive it with `playwright-core` installed in the scratchpad (not the repo) and Chromium from
`/opt/pw-browsers`, viewport 1440 x 900 at device scale 2, light and dark via the account
theme, crop to the feature area, encode WebP with CDP `Page.captureScreenshot({format:
"webp", quality: 80})` or `convert -quality 80`, keep each file under 250 KB, and write alt
text in the style of `docs/getting-started/first-run.md`. Store the capture script outside
the repo or add it under `webui/scripts/` only if it needs no new dependency.

## 7. Entry-bundle impact

- Entry: gate effect and import thunk, registry row and route thunk, the `define` string,
  one icon. Estimate +250 to +450 B (not measured).
- Lazy: `WhatsNewHost` (decision, dialog, figure), `pages/WhatsNew` (tracker), the notes
  JSON (about 25 to 40 KB raw for the backfill, an estimate), the lightbox.
- Images are not in any chunk: they are same-origin files under `/docs/<line>/assets/releases/`,
  fetched only when the dialog or the page shows them, with `width`/`height` set and
  `loading="lazy"` below the first figure.

## 8. Test plan (consolidated)

Backend (`backend/tests/`):

- `test_round16_whats_new_prefs.py`: normalizers, audited marker write, 503 on audit
  failure, no-op resend.
- `test_round16_release_history.py` (if R5): boot record, idempotence, cap, recovery skip,
  lazy record after purge, eligibility table, auth off, route auth coverage.
- A docs-records test that the notes name real pages and that the current version has a
  notes file.

Scripts:

- `scripts/test_build_release_notes.py`: validation rules and `--check` drift.
- `check_version` cases for R10.

Console (`webui/src/**/__tests__/`, `npm run test:strict`, zero stderr):

- `whats-new/decide.test.ts`: every row of the 4.2 table.
- `whats-new/gate.test.tsx`: no chunk when current; no mount on Login, password change,
  Wizard, ReauthDialog open; deep-link deferral; stamp on wizard completion.
- `whats-new/WhatsNewDialog.test.tsx`: focus on title, Escape and each close path write the
  marker once, focus to `#socMain`, theme-matched figure, Open hidden without grant, axe.
- `pages/__tests__/WhatsNew.test.tsx`: tracker behaviours in R2, axe in both themes.
- Registry, nav, titles, visual-standard and console-map contracts updated; bundle budget
  plus the "notes not in entry" assertion.

Manual (sandbox, Chromium): sign in to the seeded Demo, see the welcome once, reload (no
dialog), set the marker to an older id with `PUT /api/prefs/user` (dialog lists the newer
updates), open a case deep link (no dialog until the next landing page), 390 px phone
width, light and dark, reduced motion.

## 9. Suggested work packages and order

1. WP-A (R1, R10): notes schema, generator, generated outputs, CI step, release gate.
2. WP-B (R3, R5, R6 backend): prefs keys, audit key, optional history and eligibility
   route, OpenAPI and types.
3. WP-C (R2, R6 Console, R9): Communication group, What's new page, docs and console map.
4. WP-D (R4, R8): gate, host, dialog, badge link, bundle assertions.
5. WP-E (R7): content and screenshots, captured last, after the other Round 16 UI changes.

WP-A must land first (B to D read its output); B and C can run in parallel; E closes the
round with release prep (F5).

## 10. Open questions for the orchestrator

1. Should "Communication" replace the "Notifications" group label (as proposed) or be a new
   group beside it?
2. Is an audited row per acknowledgement wanted (proposed, consistent with
   `dismissed_intros`), or should the marker be an unaudited preference?
3. Should brand-new accounts see the welcome once (simplest, R4 alone) or be suppressed
   (needs R5)?

## Sources

- [Figma] Figma release notes: https://www.figma.com/release-notes/
- [Released.so, secondary] Figma release notes template commentary: https://www.released.so/templates/figma-release-notes
- [GitHub changelog] Improvements to changelog experience (2025-05-06): https://github.blog/changelog/2025-05-06-improvements-to-changelog-experience
- [Linear 2020] Project visualizations and in-app changelog: https://linear.app/changelog/2020-07-14-project-visualizations-and-in-app-changelog
- [Raycast changelog v1.74] (auto-dismiss of "See What's New"): https://www.raycast.com/changelog/macos/4
- [Notion releases]: https://www.notion.com/releases (in-app location not verified)
- [Slack release notes]: https://slack.com/release-notes/linux (in-app location not verified)
- [Vercel CLI changelog]: https://vercel.com/docs/cli/changelog
- [SaaSFrame, secondary] Vercel changelog teardown: https://www.saasframe.io/examples/vercel-changelog
- [Appcues UI patterns] Choosing the right UI pattern for your product update: https://appcues.com/blog/choosing-the-right-ui-pattern-for-your-product-update
- [Appcues] Announcing new features to users: https://www.appcues.com/playbook/announcing-new-features-to-users
- [Customer.io] Feature launch in-app messages: https://customer.io/learn/product-led-growth/feature-launch-in-app-messages
- [Intercom guide] A guide to announcing your new features: https://www.intercom.com/help/en/articles/231-a-guide-to-announcing-your-new-features
- [NN/g] Modal and nonmodal dialogs: https://www.nngroup.com/articles/modal-nonmodal-dialog/
- [Keep a Changelog 1.1.0]: https://keepachangelog.com/en/1.1.0/
- [APG] WAI-ARIA Authoring Practices, Dialog (Modal) pattern: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- [W3C 2.2.4] Understanding SC 2.2.4 Interruptions: https://www.w3.org/WAI/WCAG22/Understanding/interruptions.html
- [W3C 2.3.3] Understanding SC 2.3.3 Animation from Interactions: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- [web.dev lazy loading] Browser-level image lazy loading: https://web.dev/articles/browser-level-image-lazy-loading

Unverified or secondary claims are marked inline: Raycast's current auto-open behaviour,
Notion's and Slack's in-app menu locations, the Figma "What's new" versus "Release notes"
split (from a template vendor), and the Vercel page layout (from a third-party teardown).
Entry-byte and JSON-size figures in sections 5 and 7 are estimates, not measurements.
