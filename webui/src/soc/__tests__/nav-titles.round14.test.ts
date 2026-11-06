/**
 * One name per page (Round 14, D25, SPEC §4.8.2): for every routed page, the label of the
 * navigation element that is CURRENT for that page equals the page's title (`h1`).
 *
 * The test is target-aware: the current element is the page that opens it (a child's
 * `target`, else its id), so for `overview` it is the child "Cyber Defence Center", not
 * the group row "Overview" (which opens the Dashboards library). Group rows are exempt,
 * and so are the hosts whose own id is also one of their pages: Workspace and Chat,
 * Notifications and Inbox. The top-bar breadcrumb is not part of this test (it keeps
 * "Agentic SOC / Overview" on the landing page, E2).
 *
 * Titles live in page sources that other Round 14 packages migrate in parallel, so a page
 * still titled differently is listed in PENDING with the package that renames it. WP-GEN
 * empties PENDING on the merged tree; a page not listed must match now.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../registry';
import { navCurrentLabel, navDest, type PageId } from '../nav';
import { SETTINGS_REDIRECTS } from '../router';

const SRC = path.resolve(process.cwd(), 'src/soc');

/** Where each page's title is written (any listed file may hold it). */
const TITLE_SOURCES: Partial<Record<PageId, string[]>> = {
  overview: ['pages/Overview.tsx'],
  dashboards: ['pages/Dashboards.tsx', 'dashboard/Library.tsx'],
  standup: ['pages/Standup.tsx'],
  cases: ['pages/Cases.tsx'],
  case_manager: ['pages/CaseManager.tsx'],
  campaigns: ['pages/Campaigns.tsx'],
  logs: ['pages/UnifiedLogs.tsx'],
  investigate: ['pages/Workspace.tsx', 'pages/Investigate.tsx'],
  reports: ['pages/Reports.tsx'],
  approvals: ['pages/Approvals.tsx'],
  knowledge: ['pages/Intelligence.tsx', 'pages/Knowledge.tsx'],
  runbooks: ['pages/Intelligence.tsx', 'pages/Runbooks.tsx'],
  memory: ['pages/Intelligence.tsx', 'pages/Memory.tsx'],
  personas: ['pages/Intelligence.tsx', 'pages/Personas.tsx'],
  metrics: ['pages/Analytics.tsx', 'pages/Metrics.tsx'],
  effectiveness: ['pages/Analytics.tsx', 'pages/AgentEffectiveness.tsx'],
  cost: ['pages/Analytics.tsx', 'pages/Cost.tsx'],
  models: ['pages/Models.tsx'],
  baseline: ['pages/Baseline.tsx'],
  batchjobs: ['pages/BatchJobs.tsx'],
  sources: ['pages/Sources.tsx'],
  audit: ['pages/Audit.tsx'],
  tuning: ['pages/Tuning.tsx'],
  settings: ['pages/Settings.tsx'],
  docs: ['pages/Docs.tsx'],
};

/** Hosts whose own id is also one of their pages (listed by name in the spec). */
const EXEMPT_HOSTS: readonly PageId[] = ['chat', 'inbox'];

/** Pages still titled differently, with the package that renames them (§4.9.4). */
const PENDING: Partial<Record<PageId, string>> = {};

/** Every page a visible navigation element opens, except group rows and redirects. */
function destinationPages(): PageId[] {
  const pages = new Set<PageId>();
  for (const feature of FEATURES.filter((f) => !f.hidden)) {
    const children = feature.children ?? [];
    if (children.length === 0) pages.add(feature.id);
    for (const child of children) pages.add(navDest(child));
  }
  return [...pages].filter(
    (page) => !Object.prototype.hasOwnProperty.call(SETTINGS_REDIRECTS, page) && !EXEMPT_HOSTS.includes(page),
  );
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The page writes `label` AS ITS TITLE, not merely somewhere: a `title` prop or field
 * (`title="X"`, `title={'X'}`, `title={t('key', 'X')}`, `title: 'X'` in a page table), a
 * title constant (`PAGE_TITLE = 'X'`), or an `<h1>` holding the text. A toast, a link or
 * an aria-label with the same words does not count.
 */
function titlePattern(label: string): RegExp {
  const quote = `["'\`]`;
  const text = `${quote}${escapeRe(label)}${quote}`;
  return new RegExp(
    [
      `\\btitle\\s*[=:]\\s*\\{?\\s*(?:t\\(\\s*${quote}[\\w.-]+${quote}\\s*,\\s*)?${text}`,
      `\\b[A-Z_]*TITLE\\s*=\\s*${text}`,
      `<h1\\b[^>]*>\\s*${escapeRe(label)}\\s*</h1>`,
    ].join('|'),
  );
}

function titleWritten(page: PageId, label: string): boolean {
  return (TITLE_SOURCES[page] ?? [])
    .map((file) => path.join(SRC, file))
    .filter((file) => existsSync(file))
    .some((file) => titlePattern(label).test(readFileSync(file, 'utf8')));
}

describe('one name per page: the current navigation label is the page title', () => {
  it('counts only a title: a prop, a page-table field, a title constant or an h1', () => {
    const cases = titlePattern('Cases');
    for (const source of [
      'title="Cases"',
      "title={'Cases'}",
      "title={t('cases', 'Cases')}",
      "title: 'Cases',",
      "const PAGE_TITLE = 'Cases';",
      '<h1 className="text-lg">Cases</h1>',
    ]) {
      expect(cases.test(source), source).toBe(true);
    }
    for (const source of [
      "toast.success('Cases')",
      'ariaLabel="Cases"',
      "{ label: 'Cases' }",
      'subtitle="Cases"',
      '<SheetTitle>Cases</SheetTitle>',
      'title="Cases and alerts"',
    ]) {
      expect(cases.test(source), source).toBe(false);
    }
  });

  it('knows where every destination page writes its title', () => {
    const missing = destinationPages().filter((page) => !TITLE_SOURCES[page]);
    expect(missing).toEqual([]);
  });

  it('names the landing page by its current element, the child "Cyber Defence Center"', () => {
    expect(navCurrentLabel('overview')).toBe('Cyber Defence Center');
    expect(navCurrentLabel('dashboards')).toBe('Dashboards');
    expect(navCurrentLabel('docs')).toBe('Help Center');
    expect(navCurrentLabel('runbooks')).toBe('Runbooks');
  });

  it.each(destinationPages().filter((page) => !PENDING[page]))('%s is titled by its navigation label', (page) => {
    const label = navCurrentLabel(page);
    expect(label, `${page} has no current navigation element`).toBeTruthy();
    expect(titleWritten(page, label as string), `${page}: no page source writes the title "${label}"`).toBe(true);
  });

  it('lists only real destination pages as pending, each with its owner', () => {
    const pages = new Set(destinationPages());
    for (const [page, owner] of Object.entries(PENDING)) {
      expect(pages.has(page as PageId), page).toBe(true);
      expect(owner).toMatch(/^WP-/);
    }
  });
});
