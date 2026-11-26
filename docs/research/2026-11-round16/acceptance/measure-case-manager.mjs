#!/usr/bin/env node
/**
 * Measure the Case Manager's vertical budget (Round 16 SPEC §4.4 WP02 and WP03, C31, C40).
 *
 * Prints, at 1440 by 900 and at 390 by 844:
 *
 *   frameTop       the top of the split frame (`case-manager-split-frame`), the board
 *   bandHeight     the queue's control band (`case-queue-controls`), inside its bottom
 *                  hairline
 *   headerHeight   the case header (`case-detail-header`)
 *   firstContent   the top of the active tab's first child: `[data-testid="case-tab-first"]`
 *                  when the build marks it (WP03), else the first child of the active tab
 *                  panel, reported with the selector it used
 *
 * Every value is in CSS pixels from the top of the window, rounded to one decimal. The
 * WP02 targets at 1440 by 900 are frameTop 72 and bandHeight 92 (at most 112 with the AI
 * notice); the WP03 targets are headerHeight at most 120 and firstContent at most 210 at
 * both sizes, for a normal case and a pending review case.
 *
 * It runs outside the build and the npm dependency graph, against a running Console (the
 * seeded demo is the reference: `DEMO_MODE=seeded ./scripts/run-demo.sh`, sign-in
 * Admin / Admin@123). It loads the globally installed Playwright: `playwright` from the
 * script's resolution path, else `PLAYWRIGHT_MODULE`, else `/opt/node-tools/node_modules/playwright`
 * (the package behind `/opt/node22/bin/playwright`).
 *
 * Usage:
 *   node docs/research/2026-11-round16/acceptance/measure-case-manager.mjs \
 *     [--url http://127.0.0.1:5173] [--user Admin] [--password Admin@123] \
 *     [--case <case_id>] [--review-case <case_id>] [--json]
 *
 * Without `--case` the queue's first row is measured. `--review-case` adds a second
 * measurement for a case in the auto-close review sample (its header carries a review chip).
 *
 * The What's new welcome opens once per update on a landing page such as `#/case_manager`,
 * and while it is open its modal hides the page from the accessibility tree. The script
 * presses Got it whenever the dialog shows, so it runs on a fresh account too.
 */
import { createRequire } from 'node:module';
import process from 'node:process';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
];

function parseArgs(argv) {
  const out = { url: 'http://127.0.0.1:5173', user: 'Admin', password: 'Admin@123', case: null, reviewCase: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--url') out.url = next().replace(/\/+$/, '');
    else if (arg === '--user') out.user = next();
    else if (arg === '--password') out.password = next();
    else if (arg === '--case') out.case = next();
    else if (arg === '--review-case') out.reviewCase = next();
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Playwright not found: install it globally or set PLAYWRIGHT_MODULE to its package folder.');
}

const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/** Sign in through the Console's form (one or two steps), unless the session is already open. */
async function signIn(page, args) {
  await page.goto(`${args.url}/#/case_manager`, { waitUntil: 'domcontentloaded' });
  const ready = page.locator('[data-testid="case-manager"]');
  const username = page.locator('input[autocomplete="username"]:visible').first();
  await Promise.race([ready.waitFor({ timeout: 30_000 }), username.waitFor({ timeout: 30_000 })]);
  if (await ready.isVisible().catch(() => false)) {
    await dismissWhatsNew(page);
    return;
  }
  await username.fill(args.user);
  const password = page.locator('input[autocomplete="current-password"]:visible').first();
  if (!(await password.isVisible().catch(() => false))) {
    await username.press('Enter');
    await password.waitFor({ timeout: 15_000 });
  }
  await password.fill(args.password);
  await password.press('Enter');
  await ready.waitFor({ timeout: 30_000 });
  await dismissWhatsNew(page);
}

/**
 * Close the What's new welcome when it shows, pressing Got it (the account's marker is then
 * current, so it does not show again). Waits up to `waitMs` for the dialog, which opens a
 * moment after the page, and answers whether it closed one.
 */
async function dismissWhatsNew(page, waitMs = 2_500) {
  const dialog = page.locator('[data-testid="whats-new-dialog"]');
  try {
    await dialog.waitFor({ state: 'visible', timeout: waitMs });
  } catch {
    return false;
  }
  await dialog.getByRole('button', { name: 'Got it', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
  return true;
}

async function box(page, selector) {
  const handle = page.locator(selector).first();
  if (!(await handle.count())) return null;
  return handle.boundingBox();
}

/** The top of the active tab's first child, with the selector that found it. */
async function firstContent(page) {
  return page.evaluate(() => {
    const marked = document.querySelector('[data-testid="case-tab-first"]');
    if (marked) return { top: marked.getBoundingClientRect().top, via: '[data-testid="case-tab-first"]' };
    const panel = document.querySelector('[data-testid="embedded-case-detail"] [role="tabpanel"][data-state="active"], [role="tabpanel"][data-state="active"]');
    if (!panel) return null;
    // The first element child that takes room (a wrapper with padding counts by its content).
    let node = panel;
    for (let depth = 0; depth < 4 && node.firstElementChild; depth += 1) {
      const child = node.firstElementChild;
      const style = getComputedStyle(node);
      const padded = parseFloat(style.paddingTop) > 0;
      node = child;
      if (padded) break;
    }
    return { top: node.getBoundingClientRect().top, via: 'first child of the active tab panel' };
  });
}

async function measureCase(page, args, viewport, caseId) {
  await page.goto(`${args.url}/#/case_manager${caseId ? `?caseId=${encodeURIComponent(caseId)}` : ''}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('[data-testid="case-manager-split-frame"]').waitFor({ timeout: 30_000 });
  await dismissWhatsNew(page, 1_000);
  const frame = await box(page, '[data-testid="case-manager-split-frame"]');
  // The queue opens its first case on arrival; open it by hand if it did not.
  const header = page.locator('[data-testid="case-detail-header"]').first();
  // A row's open control (its checkbox is a sibling button, often hidden).
  const row = page.locator('[data-testid="case-queue-row"] > button[aria-keyshortcuts]').first();
  await Promise.race([header.waitFor({ timeout: 30_000 }), row.waitFor({ timeout: 30_000 })]);
  if (!(await header.isVisible().catch(() => false))) {
    await page.waitForTimeout(1_000);
    if (!(await header.isVisible().catch(() => false))) await row.click();
  }
  await header.waitFor({ timeout: 30_000 });
  // Let the case settle (the record replaces the queue row in the background).
  await page.waitForTimeout(1_500);
  const headerBox = await header.boundingBox();
  const content = await firstContent(page);
  // The band, on the queue's own screen below xl (there the queue and the case are two).
  if (viewport.width < 1280) {
    await dismissWhatsNew(page, 500);
    await page.getByRole('button', { name: 'Back to case queue' }).click();
    await page.locator('[data-testid="case-queue-controls"]').first().waitFor({ timeout: 15_000 });
  }
  // Inside its bottom hairline (`clientHeight`), as the SPEC's 92px counts it.
  const band = await page
    .locator('[data-testid="case-queue-controls"]')
    .first()
    .evaluate((el) => ({ height: el.clientHeight }))
    .catch(() => null);
  return {
    viewport: viewport.name,
    case: caseId ?? 'first row',
    frameTop: round(frame?.y),
    bandHeight: round(band?.height),
    headerHeight: round(headerBox?.height),
    firstContent: round(content?.top),
    firstContentVia: content?.via ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: measure-case-manager.mjs [--url URL] [--user NAME] [--password PASSWORD] [--case ID] [--review-case ID] [--json]');
    return;
  }
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      await signIn(page, args);
      results.push(await measureCase(page, args, viewport, args.case));
      if (args.reviewCase) results.push(await measureCase(page, args, viewport, args.reviewCase));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results) {
    console.log(
      `${r.viewport}  ${r.case}: frame top ${r.frameTop}, band ${r.bandHeight}, header ${r.headerHeight}, first content ${r.firstContent} (${r.firstContentVia})`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
