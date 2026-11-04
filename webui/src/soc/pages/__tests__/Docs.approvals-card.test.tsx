/**
 * The Help Center's Approvals card (Round 14, SPEC §9.1): the approvals guide moved from
 * `automation/playbooks-approvals.md` to `automation/approvals.md`, so the card opens the
 * new page. Every card's path also has to name a page the Help Center actually builds
 * (a Markdown file listed in the `mkdocs.yml` navigation), so a moved page can never
 * leave a card pointing at a stub or a missing page.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ReleaseIdentity } from '@/lib/release';
import Docs, { DOC_CATEGORIES } from '../Docs';

const release: ReleaseIdentity = { version: '0.1.13', channel: 'testing', commitSha: 'abc1234', buildTime: '2026-10-29T00:00:00Z' };

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const MKDOCS_YML = readFileSync(path.join(REPO_ROOT, 'mkdocs.yml'), 'utf8');

/** The Markdown source a card path (`automation/approvals/`, `sources/`) is built from. */
function sourceOf(cardPath: string): string | null {
  const stem = cardPath.replace(/\/$/, '');
  for (const candidate of [`${stem}.md`, `${stem}/index.md`]) {
    if (existsSync(path.join(DOCS_DIR, candidate))) return candidate;
  }
  return null;
}

describe('Help Center approvals card', () => {
  it('opens the approvals guide at its new address', () => {
    render(<Docs releaseIdentity={release} backendInfo={null} />);
    expect(screen.getByRole('link', { name: /^Approvals/ })).toHaveAttribute('href', '/docs/0.1/automation/approvals/');
  });

  it('never points a card at the page that moved', () => {
    const paths = DOC_CATEGORIES.flatMap((category) => category.articles.map((article) => article.path));
    expect(paths).toContain('automation/approvals/');
    expect(paths).not.toContain('automation/playbooks-approvals/');
  });

  it('points every card at a page the Help Center builds', () => {
    for (const category of DOC_CATEGORIES) {
      for (const article of category.articles) {
        const source = sourceOf(article.path);
        expect(source, `${article.title}: ${article.path}`).not.toBeNull();
        expect(MKDOCS_YML, `${article.title}: ${source} is not in the mkdocs.yml navigation`).toContain(source as string);
      }
    }
  });
});
