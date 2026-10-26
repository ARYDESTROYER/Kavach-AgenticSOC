/**
 * Build-artifact regression test — keeps heavy vendor libraries OUT of the
 * first-paint (entry) graph.
 *
 * Two perf-bundle findings this locks:
 *   1. recharts (422 KB / 112 KB gzip) was eagerly loaded on first paint because a
 *      manualChunks co-location bug pulled clsx into the recharts chunk, so the
 *      entry's cn() statically imported recharts. Fix: split clsx/tailwind-merge
 *      into their own `utils` chunk BEFORE the recharts branch in vite.config.ts.
 *   2. framer-motion (111 KB / 37 KB gzip) loaded on first paint via the eager
 *      Login -> loginParts -> framer-motion chain. Fix: the login hero animation is
 *      now pure CSS, so framer-motion is gone from the bundle entirely.
 *   3. motion.dev (the framer-motion successor, npm `motion`) was RE-ADDED behind a
 *      single lazy boundary (soc/components/motion/*): the provider + `m` re-export are
 *      reached ONLY through lazy page chunks (CaseDetail/Cases, each wrapping itself in
 *      MotionProvider) + AppShell's DYNAMIC import() of RouteMotion. So a `motion-*.js`
 *      chunk now EXISTS but must stay lazy — never modulepreloaded, never statically
 *      imported by the entry, and never imported by the eager App/Login/Wizard/AppShell/
 *      NavSidebar chain (mirrors the recharts lazy-chunk pattern).
 *
 * The assertions read the PRODUCED bundle (the static `dist/` output IS the check —
 * there is no browser/Playwright dependency). They run against an already-built
 * `dist/` (the CI / integrator flow is `vite build` then the test suite). When no
 * build is present these build-artifact cases SKIP with a clear hint rather than
 * fail — a programmatic build cannot run inside the jsdom test environment because
 * esbuild requires a real Node env. The source-level guards below need no build and
 * always run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .../webui/src/soc/__tests__ -> .../webui
const WEBUI_ROOT = path.resolve(HERE, '..', '..', '..');
const DIST = path.join(WEBUI_ROOT, 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST, 'index.html'));
// The CI production-build lane runs this file after `npm run build` with
// REQUIRE_DIST_BUILD=1, so the build-artifact cases below run there and can never pass by
// skipping; the test lane (no build) still skips them and keeps the source guards.
const REQUIRE_DIST = process.env.REQUIRE_DIST_BUILD === '1';

const HINT = 'no dist/ build present — run `vite build` first (CI/integrator does)';

/*
 * Chat revamp entry budget (SPEC §1, §10.10): the whole revamp may add at most 1 kB to the
 * entry chunk. The baseline is the entry chunk at 05a40d1 (the revamp's branch point),
 * measured with `vite build` (file size on disk, as `statSync` reads it below).
 *
 * Rebased for the lazy MFA QR code. 05a40d1 as committed measures 396,537 B. Making the
 * login card's QR encoder a fail-soft `React.lazy` chunk (MfaSetupCard.tsx) moves
 * pre-revamp code out of the entry, and that saving must not become chat headroom. So
 * the baseline is 05a40d1 re-measured with only that change applied (its own vite
 * config): 391,893 B, which is 4,644 B less. The revamp stays capped at +1,024 B. Re-measure
 * the same way if another pre-revamp module leaves or joins the entry.
 *
 * Rebased for Round 12 (SPEC §6, WP-GEN-A). The round's features grew the entry from
 * 392,879 B (6769207, the round's branch point) to 399,967 B: +7,088 B, 8,074 B over the
 * 391,893 B baseline and 33 B under the 400,000 B ceiling. The growth: Remember me in
 * Login / auth / the api client (~2.8 kB), per-viewer preference writes (`patchMisc`,
 * reduced transparency) and the nav activity glyph in prefs.tsx / NavSidebar.tsx
 * (~2.6 kB), the chat activity store, glyph and title (~0.8 kB, SPEC D13: the only new
 * entry code the round planned) and the design foundations (ui-recipes, transparency,
 * overlay origins: ~0.9 kB net). WP-GEN-A then moved code first
 * paint never needs out of the entry, keeping every feature:
 *   - the command palette body (CommandPalette, cmdk, ui/command: ~20 kB) is a fail-soft
 *     lazy chunk AppShell mounts on the first Cmd/Ctrl-K or search click (its chunks are
 *     prefetched into the HTTP cache when the browser is idle, never imported early);
 *   - the Settings section metadata (settings-sections-meta + settings-dirty: ~15.5 kB)
 *     left with it, once the shell's unsaved-changes hook took `deepEqual` from the
 *     dependency-free lib/deep-equal.ts instead of settings-dirty.ts;
 *   - the shell's two Blob downloads (job artifacts, MFA recovery codes) now share
 *     lib/download-blob.ts, whose deferred revoke cannot cancel a download (+223 B).
 * Measured with `npm run build:app`: 365,547 B, 34,420 B less than before the pass. The
 * baseline is that measurement; later work keeps the +1,024 B budget over it.
 * The review fixes that keep a network blip from disabling search, Chat or Settings
 * spend ~1 kB of that budget: the retrying chunk loader and the prefetch-only warm in
 * soc/lazy-retry.ts, the build-written list of the palette's chunks (vite.config.ts
 * `chunkListPlugin`) and the palette's one-toast Reload path. With the rest of the
 * working tree at its state then, the entry measured 365,885 B before those fixes and
 * 366,517 B after them (`vite build`, the same way), 54 B under the budget.
 *
 * Rebased for the Round 12 final review (L3/L4). Two fixes that must run on first paint
 * took the entry to 367,234 B, 663 B over the budget (98078d4 re-measured 366,517 B the
 * same way, so the per-source deltas below are exact):
 *   - router.tsx +788 B: the same-page hash reconciliation (`samePageOpts`, `hashKeys`)
 *     that lets Back leave a report and keeps a Case Manager row change from erasing a
 *     drill-through. It runs synchronously on every hash change of the eager
 *     RouterProvider, so it cannot be a lazy chunk;
 *   - the `chat.read` relay, +124 B (chat-activity/store.ts, JobMonitor.tsx,
 *     useEventStream.ts): the shell's one stream hands the lazy activity observer the
 *     frames that clear an answer read on another console;
 *   - Login.tsx -209 B (Remember me tidy-up), others within ±20 B.
 * `optsFromHash` then read the same `hashKeys` table instead of its own per-key copy
 * (-397 B, one source of truth for the keys, validators and trim rule). Measured with
 * `vite build` that way: 366,837 B. A CI build stamps a 40-character commit and a build
 * time where a local build writes `unknown`, about 46 B more.
 *
 * Rebased for the Round 12 final polish (top bar, P1-shell-header-material) by exactly
 * the top bar's own first-paint bytes, +1,428 B, measured by building the same tree with
 * and without each file (`vite build`, the same way): AppShell.tsx +958 B (the bar's
 * container tiers, the page name's priority, the health pill's tooltip, the Console
 * controls sheet as the desktop overflow), DemoIndicator.tsx +439 B (its tooltip and the
 * muted-health note the health pill used to carry), SystemUpdateControl.tsx +31 B. The
 * bar is the first thing every page paints, so none of it can be a lazy chunk.
 *
 * Rebased again for the final top bar fixer by exactly its first-paint bytes, +2,738 B:
 * the same tree built with and without the change (`vite build`, the same way) measured
 * 371,445 B and 368,707 B. It is top-bar-fold.ts (the measured fold that lets crowded
 * chips give way before the search field drops under 11rem: the fold order, the six
 * literal fold classes, the measure and the hook), the search field's own-width tiers,
 * and the fold classes on each chip label. The fold must decide before first paint (a
 * lazy chunk would paint the overflowing bar first), so it cannot be split out. Other
 * work keeps the +1,024 B budget over 371,003 B.
 *
 * Rebased once for Round 14 (its SPEC §3.4 and E11, package R; the record is that SPEC's
 * §11.1 "Entry bundle" item). The round's spec commit and WP-0 (07a0a8f) measure
 * 371,876 B with `vite build`; WP-0, W1, W2a, W2b and W3 took the entry to 384,789 B.
 * Package R then moved what first paint never needs out of it, keeping every behaviour:
 *   - the collapsed rail's interaction layer (the group flyouts, their hover intent, the
 *     one rail tooltip and the handlers that drive them) is the lazy chunk
 *     nav-rail-interactions.tsx. nav-rail-loader.ts prefetches it into the HTTP cache when
 *     the browser is idle, loads it on the rail's first pointer move or focus, and replays
 *     that first interaction once the handlers attach: NavSidebar.tsx -4,744 B,
 *     nav-rail-tip.tsx -1,900 B, nav-hover-intent.ts -1,719 B, nav-rail-loader.ts
 *     +1,675 B, nav-shared.ts +295 B (helpers both halves share);
 *   - Field's two Settings row layouts are renderers in the lazy Settings primitives
 *     (pages/settings/field-layouts.tsx) that SettingRow hands to Field through
 *     FieldLayoutContext, so Login and Wizard, which import Field, never carry them:
 *     Field.tsx -1,380 B.
 * With +54 B of attribution drift on main.tsx, whose source did not change, that pass
 * measured 377,070 B (-7,719 B), with W1 (uncommitted then) in the tree. Its
 * growth over 371,876 B is +5,194 B, per file (each output byte mapped to its source
 * through the source map): nav-store.ts +2,125 (the rail state, open groups and
 * breadcrumb trail, hydrated synchronously so the rail never flashes), router.tsx +1,558
 * (the Round 14 deep-link keys and page redirects, validated on the eager first route),
 * nav-rail-loader.ts +1,675, platform-keys.ts +332, nav.ts +327, nav-shared.ts +295,
 * Field.tsx +215 (the row renderer hook), NavSidebar.tsx -710, AppShell.tsx -480,
 * registry.tsx -191, auth.tsx -120 and Login.tsx -110 (W1), ui/sheet.tsx +11, the
 * build-written chunk list +14, and +253 of attribution drift on files whose source did
 * not change (main.tsx +153, EmptyState.tsx +114, others -14). Each of those runs before
 * or during first paint. The baseline is that measurement; later work (W9b on Login and
 * Wizard, A7c on the stream channels) keeps the +1,024 B budget over it, and the
 * 400,000 B ceiling does not move. Package R's review fixes spent 162 B of that budget,
 * measured at 377,232 B: nav-rail-loader.ts +156 (a failed load is retried on a later
 * interaction after a pause, never on every pointer move) and NavSidebar.tsx +6 (a
 * grouped icon registers in a layout effect, before the replayed first interaction).
 */
const PRE_REVAMP_ENTRY_BYTES = 377_070;
const REVAMP_ENTRY_BUDGET_BYTES = 1_024;

function readHtml(): string {
  return fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
}
function readEntry(): string {
  const html = readHtml();
  const m = html.match(/src="\/assets\/(index-[^"]+\.js)"/);
  if (!m) throw new Error('could not find the entry chunk in dist/index.html');
  return fs.readFileSync(path.join(DIST, 'assets', m[1]), 'utf8');
}

/** Chunk file names the entry imports statically (`from"./x.js"`). */
function entryStaticImports(): string[] {
  return [...readEntry().matchAll(/from\s*["']\.\/([A-Za-z0-9._-]+\.js)["']/g)].map((mm) => mm[1]);
}

describe.runIf(REQUIRE_DIST)('first-paint bundle graph is checked on the built output', () => {
  it('a production build is present', () => {
    expect(HAS_DIST, 'REQUIRE_DIST_BUILD=1 but dist/index.html is missing: run `npm run build` first').toBe(true);
  });
});

describe.skipIf(!HAS_DIST && !REQUIRE_DIST)('first-paint bundle graph', () => {
  if (!HAS_DIST && !REQUIRE_DIST) it.skip(HINT, () => undefined);

  it('does NOT modulepreload recharts on first paint', () => {
    expect(readHtml()).not.toMatch(/modulepreload[^>]*recharts/);
  });

  it('does NOT modulepreload the motion.dev chunk (motion-*.js) on first paint', () => {
    // motion.dev lives in a LAZY `motion-*.js` chunk (manualChunks routes
    // node_modules/motion there). It must never be modulepreloaded from index.html —
    // it loads only when a lazy page/AppShell dynamic import pulls it.
    // (`motion-reduce` Tailwind utility classes are not chunk filenames.)
    expect(readHtml()).not.toMatch(/modulepreload[^>]*\/motion-[^"']+\.js/);
  });

  it('entry chunk does NOT statically import recharts (a lazy dynamic import is allowed)', () => {
    // A static `from"./recharts-*.js"` in the entry is the bug; a dynamic
    // `import("./recharts-*.js")` from a React.lazy chart page is fine.
    expect(readEntry()).not.toMatch(/from\s*["']\.\/recharts-[^"']+\.js["']/);
  });

  it('entry chunk does NOT statically import the motion.dev chunk (motion-*.js)', () => {
    // A static `from"./motion-*.js"` in the entry would put motion.dev on first paint;
    // a dynamic `import("./motion-*.js")` off a lazy page/AppShell is fine.
    expect(readEntry()).not.toMatch(/from\s*["']\.\/motion-[^"']+\.js["']/);
  });

  it('a LAZY motion-*.js chunk IS emitted (motion.dev is code-split, not on first paint)', () => {
    // Mirrors the recharts assertions above: the chunk must EXIST (proof the animation
    // layer shipped) but stay off the entry graph (the modulepreload + static-import +
    // "entry imports ONLY vendor chunks" assertions guard that it never rides first paint).
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    expect(assets.filter((f) => /^motion-[^/]+\.js$/.test(f)).length).toBeGreaterThan(0);
  });

  /* -------------------------------------------------------------------------- *
   * Round-5 Coupling-A — the FEATURES[]-derived ROUTES table + the settings-
   * sections meta split keep every page body (and the heavy Settings renderer
   * tree that the always-on CommandPalette used to drag in) OUT of the entry.
   * The entry had ballooned to ~537 kB; these assertions lock the shrink so a
   * future eager import of a page / settings section can't silently re-bloat it.
   * -------------------------------------------------------------------------- */

  it('entry chunk is well under the pre-Coupling-A 537 kB (page bodies are lazy)', () => {
    const html = readHtml();
    const m = html.match(/src="\/assets\/(index-[^"]+\.js)"/);
    if (!m) throw new Error('could not find the entry chunk in dist/index.html');
    const bytes = fs.statSync(path.join(DIST, 'assets', m[1])).size;
    // Hard ceiling below the 537 777-byte regression. After the Round 14 rebase the entry
    // chunk is ~377 kB, so the headroom is ~23 kB; the recorded-baseline test below still
    // caps any growth at 1 kB. Keep the figure current when it moves.
    expect(bytes).toBeLessThan(400_000);
  });

  it('the chat revamp grows the entry chunk by at most 1 kB over the recorded baseline', () => {
    const html = readHtml();
    const m = html.match(/src="\/assets\/(index-[^"]+\.js)"/);
    if (!m) throw new Error('could not find the entry chunk in dist/index.html');
    const bytes = fs.statSync(path.join(DIST, 'assets', m[1])).size;
    // Chat, reports and the palette's chat entries reach the entry only as nav metadata
    // and `React.lazy` thunks; everything else lives in lazy chunks.
    expect(bytes - PRE_REVAMP_ENTRY_BYTES, `entry is ${bytes} B`).toBeLessThanOrEqual(REVAMP_ENTRY_BUDGET_BYTES);
  });

  it('the command palette body (cmdk) and the Settings section metadata stay off first paint', () => {
    // Round 12 WP-GEN-A: AppShell mounts the palette lazily; cmdk writes its `cmdk-*`
    // attribute names as string literals, so their absence proves cmdk is not in the entry.
    const entry = readEntry();
    expect(entry).not.toContain('cmdk-input');
    expect(entry).not.toContain('cmdk-item');
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    expect(assets.some((f) => /^CommandPalette-[^/]+\.js$/.test(f))).toBe(true);
    expect(readHtml()).not.toMatch(/modulepreload[^>]*CommandPalette/);
    // The Settings section metadata (settings-sections-meta, settings-dirty) rides only
    // with lazy chunks: never modulepreloaded, never a static import of the entry, and
    // none of its section keywords inside the entry itself.
    expect(readHtml()).not.toMatch(/modulepreload[^>]*settings-(?:sections-meta|dirty)/);
    const statics = entryStaticImports();
    expect(statics.filter((name) => /settings|CommandPalette|cmdk/i.test(name))).toEqual([]);
    expect(entry).not.toContain(SETTINGS_META_MARKER);
    const metaChunk = assets
      .filter((f) => f.endsWith('.js'))
      .find((f) => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8').includes(SETTINGS_META_MARKER));
    expect(metaChunk, 'the Settings section metadata must be emitted in some lazy chunk').toBeDefined();
    expect(statics).not.toContain(metaChunk);
  });

  it("the rail's interaction layer and Field's Settings row layouts stay off first paint", () => {
    // Round 14 (SPEC §3.4, package R): the rail tooltip carries the `nav-rail-tip` test id
    // and the row layouts the `data-field-layout` attribute; neither may be in the entry.
    const entry = readEntry();
    expect(entry).not.toContain('nav-rail-tip');
    expect(entry).not.toContain('data-field-layout');
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    const layer = assets.filter((f) => /^nav-rail-interactions-[^/]+\.js$/.test(f));
    expect(layer, 'the rail interaction layer is its own lazy chunk').toHaveLength(1);
    expect(fs.readFileSync(path.join(DIST, 'assets', layer[0]), 'utf8')).toContain('nav-rail-tip');
    expect(readHtml()).not.toMatch(/modulepreload[^>]*nav-rail-interactions/);
    expect(entryStaticImports()).not.toContain(layer[0]);
    // The entry reaches it only through import(), and warms it with a build-written chunk
    // list (a prefetch into the HTTP cache, never an import: lazy-retry.ts).
    expect(entry).toMatch(new RegExp(`import\\(\\s*["']\\./${layer[0].replace(/\./g, '\\.')}["']\\s*\\)`));
    const lists = [...entry.matchAll(/\[(?:\\?"[A-Za-z0-9._-]+\.js\\?",?)+\]/g)]
      .map((mm) => mm[0].replace(/\\"/g, '"'))
      .filter((text) => text.includes('nav-rail-interactions-'));
    expect(lists, 'one chunk list naming the rail layer').toHaveLength(1);
    expect(JSON.parse(lists[0]) as string[]).toContain(layer[0]);
  });

  it('the entry prefetches exactly the palette chunks first paint lacks (a build-written list)', () => {
    // vite.config.ts `chunkListPlugin` replaces AppShell's `__CHUNK_LIST:` mark with the
    // palette chunk and its static imports, minus what the entry already loads. AppShell
    // warms them with <link rel="prefetch"> (lazy-retry.ts), never through import().
    const entry = readEntry();
    expect(entry).not.toContain('__CHUNK_LIST:');
    const lists = [...entry.matchAll(/\[(?:\\?"[A-Za-z0-9._-]+\.js\\?",?)+\]/g)]
      .map((mm) => mm[0].replace(/\\"/g, '"'))
      .filter((text) => text.includes('CommandPalette-'));
    expect(lists, 'one chunk list naming the palette chunk').toHaveLength(1);
    const listed = JSON.parse(lists[0]) as string[];
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    for (const name of listed) expect(assets, name).toContain(name);
    const holding = (marker: string) =>
      assets.filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(DIST, 'assets', f), 'utf8').includes(marker));
    expect(listed.some((name) => /^CommandPalette-/.test(name))).toBe(true);
    expect(listed.some((name) => holding('cmdk-input').includes(name)), 'the cmdk chunk is listed').toBe(true);
    expect(listed.some((name) => holding(SETTINGS_META_MARKER).includes(name)), 'the Settings metadata chunk is listed')
      .toBe(true);
    const statics = entryStaticImports();
    expect(listed.filter((name) => statics.includes(name))).toEqual([]);
  });

  it("the entry's preload lists never repeat a chunk the entry already imports statically", () => {
    // vite.config.ts `resolvePreloadDependencies`: a chunk the entry imports statically
    // (react-vendor, radix, icons, utils) has loaded before any lazy import can run, so
    // listing it again in every page's preload list only grows first paint.
    const entry = readEntry();
    const statics = [...entry.matchAll(/from\s*["']\.\/([A-Za-z0-9._-]+\.js)["']/g)].map((mm) => `assets/${mm[1]}`);
    expect(statics.length).toBeGreaterThan(0);
    const table = entry.match(/m\.f=\[([^\]]*)\]/)?.[1] ?? '';
    expect(table.length).toBeGreaterThan(0);
    for (const name of statics) expect(table, name).not.toContain(`"${name}"`);
  });

  it('react-vendor carries no renderToStaticMarkup (react-dom/server stays out)', () => {
    // The HTML export is a string serialiser (BLOCKS.md amendment 8); react-dom/server in
    // the shared react-vendor chunk would ride every page.
    const vendors = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /^react-vendor-[^/]+\.js$/.test(f));
    expect(vendors.length).toBeGreaterThan(0);
    for (const f of vendors) {
      expect(fs.readFileSync(path.join(DIST, 'assets', f), 'utf8')).not.toContain('renderToStaticMarkup');
    }
  });

  it('entry chunk statically imports ONLY vendor chunks (no page/settings chunk)', () => {
    // Static `from"./<chunk>.js"` statements in the entry. The ONLY allowed static
    // app-graph imports are the shared vendor splits (react-vendor/radix/icons/utils);
    // any page or the settings-sections/Settings chunk being statically imported means
    // it rode into the first-paint bundle (the exact 537 kB regression).
    const entry = readEntry();
    const statics = [...entry.matchAll(/from\s*["']\.\/([A-Za-z0-9._-]+)\.js["']/g)].map(
      (mm) => mm[1],
    );
    const ALLOWED = /^(react-vendor|radix|icons|utils)-/;
    const offenders = statics.filter((name) => !ALLOWED.test(name));
    expect(offenders, `unexpected static entry imports: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the heavy Settings section tree is code-split out of the entry', () => {
    // The Settings renderer tree (BrandingEditor/RolesInner/DangerZone/…) lands in its
    // own chunk (today `settings-dirty-*.js`), NOT the entry. Assert such a chunk exists
    // and is a real (non-trivial) split — proof the CommandPalette no longer eager-imports
    // the component-bearing settings-sections module.
    const assets = fs.readdirSync(path.join(DIST, 'assets'));
    const settingsChunks = assets.filter((f) => /^(settings-dirty|Settings)-[^/]+\.js$/.test(f));
    expect(settingsChunks.length).toBeGreaterThan(0);
    const biggest = Math.max(
      ...settingsChunks.map((f) => fs.statSync(path.join(DIST, 'assets', f)).size),
    );
    expect(biggest).toBeGreaterThan(50_000);
  });
});

/*
 * Search keywords only the Settings section metadata carries (settings-sections-meta.ts;
 * no other source module has them). Their absence from the entry chunk proves the module
 * stayed off first paint, whatever chunk Vite puts it in.
 */
const SETTINGS_META_MARKERS = ["'analysis bundle'", "'severity weight'"];
const SETTINGS_META_MARKER = readSettingsMetaMarker();

function readSettingsMetaMarker(): string {
  const file = path.join(WEBUI_ROOT, 'src', 'soc', 'pages', 'settings', 'settings-sections-meta.ts');
  const text = fs.readFileSync(file, 'utf8');
  const marker = SETTINGS_META_MARKERS.find((m) => text.includes(m));
  // A renamed keyword must fail loudly here, never turn the bundle check into a no-op.
  if (!marker) throw new Error(`settings-sections-meta.ts no longer has ${SETTINGS_META_MARKERS.join(' or ')}`);
  return marker.slice(1, -1);
}

/*
 * The STATIC import graph of the first-paint entry (src/main.tsx), read from source: value
 * imports and re-exports only (`import type` / `export type` are erased, `import()` is a
 * lazy chunk). Runs without a build, so the CI test lane checks it too.
 */
function firstPaintGraph(): { files: Map<string, string>; packages: Map<string, string> } {
  const SRC = path.join(WEBUI_ROOT, 'src');
  const IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const files = new Map<string, string>(); // file -> the file that first imported it
  const packages = new Map<string, string>();
  const resolve = (from: string, spec: string): string | null => {
    const bare = spec.split('?')[0];
    let base: string;
    if (bare.startsWith('@/')) base = path.join(SRC, bare.slice(2));
    else if (bare.startsWith('.')) base = path.resolve(path.dirname(from), bare);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const start = path.join(SRC, 'main.tsx');
  const stack = [start];
  files.set(start, '');
  while (stack.length) {
    const file = stack.pop() as string;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith('.') && !spec.startsWith('@/')) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!packages.has(name)) packages.set(name, path.relative(WEBUI_ROOT, file));
        continue;
      }
      const target = resolve(file, spec);
      if (target && !files.has(target)) {
        files.set(target, path.relative(WEBUI_ROOT, file));
        stack.push(target);
      }
    }
  }
  return { files, packages };
}

describe('first-paint shell keeps the palette and Settings metadata lazy (source guard)', () => {
  const read = (...seg: string[]) => fs.readFileSync(path.join(WEBUI_ROOT, 'src', ...seg), 'utf8');

  it('no first-paint module statically imports the palette, cmdk or the Settings metadata', () => {
    const { files, packages } = firstPaintGraph();
    expect(files.size).toBeGreaterThan(20); // the walk really followed the entry graph
    const lazyOnly = [
      ['soc', 'components', 'CommandPalette.tsx'],
      ['ui', 'command.tsx'],
      ['soc', 'pages', 'settings', 'settings-sections-meta.ts'],
      ['soc', 'pages', 'settings-dirty.ts'],
    ].map((seg) => path.join(WEBUI_ROOT, 'src', ...seg));
    const reached = lazyOnly
      .filter((file) => files.has(file))
      .map((file) => `${path.relative(WEBUI_ROOT, file)} (imported by ${files.get(file)})`);
    expect(reached, 'lazy-only modules on the first-paint graph').toEqual([]);
    expect(packages.has('cmdk') ? `cmdk (imported by ${packages.get('cmdk')})` : null).toBeNull();
  });

  it("no first-paint module statically imports the rail's interaction layer or the Settings row layouts", () => {
    // Round 14 (SPEC §3.4, package R): the collapsed rail's flyouts, hover intent and
    // tooltip load on the rail's first interaction; Field's Settings row layouts load with
    // the Settings primitives. Both stay off the static first-paint graph.
    const { files } = firstPaintGraph();
    const lazyOnly = [
      ['soc', 'components', 'nav-rail-interactions.tsx'],
      ['soc', 'components', 'nav-hover-intent.ts'],
      ['soc', 'components', 'nav-rail-tip.tsx'],
      ['soc', 'pages', 'settings', 'field-layouts.tsx'],
      ['soc', 'pages', 'settings', 'primitives.tsx'],
    ].map((seg) => path.join(WEBUI_ROOT, 'src', ...seg));
    const reached = lazyOnly
      .filter((file) => files.has(file))
      .map((file) => `${path.relative(WEBUI_ROOT, file)} (imported by ${files.get(file)})`);
    expect(reached, 'lazy-only modules on the first-paint graph').toEqual([]);
    // The navigation itself is on the graph, and reaches the layer only through import().
    expect(files.has(path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'NavSidebar.tsx'))).toBe(true);
    const loader = read('soc', 'components', 'nav-rail-loader.ts');
    expect(loader).toMatch(/import\(\s*['"]\.\/nav-rail-interactions['"]\s*\)/);
    // The idle warm names the module the layer's chunk is built from (vite.config.ts fails
    // the build when no chunk is built from a __CHUNK_LIST mark).
    const mark = loader.match(/'__CHUNK_LIST:([^']+)__'/)?.[1];
    expect(mark).toBe('src/soc/components/nav-rail-interactions.tsx');
    expect(fs.existsSync(path.join(WEBUI_ROOT, mark as string))).toBe(true);
  });

  it('AppShell reaches the command palette only through import()', () => {
    const text = read('soc', 'AppShell.tsx');
    // A type-only import is erased; a value import would put cmdk back on first paint.
    expect(text).not.toMatch(/^import\s+(?!type\b)[^;]*['"]\.\/components\/CommandPalette['"]/m);
    expect(text).toMatch(/import\(\s*['"]\.\/components\/CommandPalette['"]\s*\)/);
  });

  it('AppShell warms the palette with a prefetch of its build-written chunk list, never import()', () => {
    const text = read('soc', 'AppShell.tsx');
    const warm = text.match(/function warmCommandPalette\(\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(warm).toContain('prefetchChunks(');
    expect(warm).not.toMatch(/loadCommandPalette|import\(/);
    // The mark names the module the palette chunk is built from (vite.config.ts fails the
    // build when no chunk is built from it).
    const mark = text.match(/'__CHUNK_LIST:([^']+)__'/)?.[1];
    expect(mark).toBe('src/soc/components/CommandPalette.tsx');
    expect(fs.existsSync(path.join(WEBUI_ROOT, mark as string))).toBe(true);
  });

  it('the eager draft hook takes deepEqual from the dependency-free lib module', () => {
    const text = read('soc', 'hooks', 'useDirtyDraft.ts');
    expect(text).toMatch(/from\s+['"]@\/lib\/deep-equal['"]/);
    expect(text).not.toMatch(/from\s+['"][^'"]*settings-dirty['"]/);
  });
});

describe('report exports stay off react-dom/server (source guard)', () => {
  it('no module under src/ imports react-dom/server', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', '__tests__', 'test'].includes(entry.name)) continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (/['"]react-dom\/server(?:\.[a-z]+)?['"]/.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(WEBUI_ROOT, full));
          }
        }
      }
    };
    walk(path.join(WEBUI_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  it('the export modules load lazily, never from the eager shell', () => {
    const EAGER = ['soc/App.tsx', 'soc/AppShell.tsx', 'soc/registry.tsx', 'soc/components/CommandPalette.tsx', 'soc/components/NavSidebar.tsx'];
    for (const rel of EAGER) {
      const full = path.join(WEBUI_ROOT, 'src', rel);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, 'utf8');
      // Only `import()` may reach the report UI; a static `from '…/chat/report/…'` may not.
      expect(text, rel).not.toMatch(/\bfrom\s+['"][^'"]*chat\/report[^'"]*['"]/);
    }
  });
});

describe('eager login chain does not pull framer-motion (source guard)', () => {
  // loginParts.tsx is the sole framer-motion importer AND is statically reachable
  // from the eager Login page. If anyone re-adds the dependency here, the login
  // screen would drag framer-motion back onto first paint.
  it('loginParts.tsx imports neither framer-motion nor any other animation lib', () => {
    const src = fs.readFileSync(
      path.join(WEBUI_ROOT, 'src', 'soc', 'components', 'auth', 'loginParts.tsx'),
      'utf8',
    );
    // No `import ... from 'framer-motion'` anywhere in the eager login part.
    expect(src).not.toMatch(/\bfrom\s+['"]framer-motion['"]/);
    expect(src).not.toMatch(/\bimport\(\s*['"]framer-motion['"]\s*\)/);
  });

  it('the eager App/Login/Wizard/AppShell/NavSidebar chain never STATICALLY imports motion.dev', () => {
    // motion.dev (`motion` / `motion/react` / `motion/react-m`) must be reached ONLY from
    // lazy chunks. AppShell may DYNAMICALLY `import('./components/motion/RouteMotion')` (a
    // local path, not the `motion` package) and hold a TYPE-ONLY import of its props; both
    // are elided/lazy. Any STATIC `from 'motion…'` on this eager chain would drag the
    // motion.dev runtime onto the entry chunk (the exact first-paint regression).
    const EAGER = [
      ['soc', 'App.tsx'],
      ['soc', 'AppShell.tsx'],
      ['soc', 'registry.tsx'],
      ['soc', 'components', 'NavSidebar.tsx'],
      ['soc', 'pages', 'Login.tsx'],
      ['soc', 'pages', 'Wizard.tsx'],
      ['soc', 'components', 'auth', 'loginParts.tsx'],
      // The identity accents are statically imported by Login.tsx, so they are on
      // the eager chain too. They animate with CSS only — this keeps it that way.
      ['soc', 'components', 'auth', 'ShineButton.tsx'],
      ['soc', 'components', 'auth', 'ThemeModePill.tsx'],
    ];
    // The `motion` PACKAGE specifier only — local `@/soc/components/motion` /
    // `./components/motion/*` imports start with `@`/`.` and never match.
    const STATIC_PKG = /\bfrom\s+['"]motion(?:\/[^'"]*)?['"]/;
    const DYNAMIC_PKG = /\bimport\(\s*['"]motion(?:\/[^'"]*)?['"]\s*\)/;
    const offenders: string[] = [];
    for (const seg of EAGER) {
      const full = path.join(WEBUI_ROOT, 'src', ...seg);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (STATIC_PKG.test(text) || DYNAMIC_PKG.test(text)) offenders.push(seg.join('/'));
    }
    expect(offenders, `eager files importing the motion.dev package: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('framer-motion is not imported anywhere under src/', () => {
    // Walk the source tree; assert framer-motion has no remaining importers (Option A
    // removed it outright). This is the strongest lock against silent re-introduction.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip build/dep output and test code (tests reference the string by name).
          if (['node_modules', 'dist', '__tests__', 'test'].includes(entry.name)) continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/['"]framer-motion['"]/.test(text)) offenders.push(path.relative(WEBUI_ROOT, full));
        }
      }
    };
    walk(path.join(WEBUI_ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
