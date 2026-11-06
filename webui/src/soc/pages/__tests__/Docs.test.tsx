import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ReleaseIdentity } from '@/lib/release';
import Docs, {
  DEVELOPMENT_DOCS_URL,
  PUBLIC_STABLE_DOCS_URL,
  documentationSourceUrl,
  docsArticleUrl,
  docsVersionLine,
} from '../Docs';

expect.extend(toHaveNoViolations);

const testingRelease: ReleaseIdentity = {
  version: '0.1.8',
  channel: 'testing',
  commitSha: 'abc1234',
  buildTime: '2026-07-21T00:00:00Z',
};

const renderDocs = (props: ComponentProps<typeof Docs> = {}) =>
  render(<Docs releaseIdentity={testingRelease} backendInfo={null} {...props} />);

describe('Help Center', () => {
  it('shows installed application, documentation, and release-channel identity', () => {
    renderDocs();

    expect(screen.getByRole('heading', { level: 1, name: 'Help Center' })).toBeVisible();
    // Round 14 (HC2): one muted line in the header actions, no band or pill.
    expect(screen.getByTestId('docs-release-line')).toHaveTextContent(
      'Version 0.1.8 · docs 0.1 · Testing',
    );
    expect(screen.queryByText('Documentation for this installation')).not.toBeInTheDocument();
  });

  it('defaults to product guidance and opens versioned articles on the same origin', () => {
    renderDocs();

    expect(screen.getByRole('heading', { level: 3, name: 'Use the product' })).toBeVisible();
    const caseManager = screen.getByRole('link', { name: /case manager/i });
    expect(caseManager).toHaveAttribute('href', '/docs/0.1/analyst/case-manager/');
    expect(caseManager).not.toHaveAttribute('target');
    expect(screen.getByRole('link', { name: /browse all guides/i })).toHaveAttribute(
      'href',
      '/docs/0.1/',
    );
    expect(screen.queryByRole('link', { name: /users and roles/i })).not.toBeInTheDocument();
  });

  it('discovers the primary Workspace Chat, Campaigns, and Analytics guides', () => {
    renderDocs();

    expect(screen.getByRole('link', { name: /workspace chat/i })).toHaveAttribute(
      'href',
      '/docs/0.1/analyst/chat/',
    );
    expect(screen.getByRole('link', { name: /^campaigns/i })).toHaveAttribute(
      'href',
      '/docs/0.1/analyst/campaigns/',
    );
    expect(screen.getByRole('link', { name: /analytics and standup/i })).toHaveAttribute(
      'href',
      '/docs/0.1/analyst/analytics/',
    );
  });

  it('describes Workspace Chat as it is now and finds it by reports, tokens, cost and export', () => {
    renderDocs();

    expect(screen.getByRole('link', { name: /workspace chat/i })).toHaveTextContent(
      'Ask read-only questions, follow each lookup, track tokens and cost, and build reports from answers.',
    );
    const search = screen.getByRole('searchbox', { name: 'Search documentation' });
    for (const term of ['report', 'reports', 'tokens', 'cost', 'export']) {
      fireEvent.change(search, { target: { value: term } });
      expect(screen.getByRole('link', { name: /workspace chat/i })).toHaveAttribute('href', '/docs/0.1/analyst/chat/');
    }
  });

  it('navigates categories without leaving the Help Center', () => {
    renderDocs();

    fireEvent.click(screen.getByRole('button', { name: /administer 7 guides/i }));

    expect(screen.getByRole('heading', { level: 3, name: 'Administer' })).toBeVisible();
    expect(screen.getByRole('link', { name: /users and roles/i })).toHaveAttribute(
      'href',
      '/docs/0.1/administration/users-rbac/',
    );
    expect(screen.queryByRole('link', { name: /^case manager/i })).not.toBeInTheDocument();
  });

  it('searches all bundled categories and can clear an empty result', () => {
    renderDocs();

    const search = screen.getByRole('searchbox', { name: 'Search documentation' });
    expect(search).toHaveAttribute('placeholder', 'Search featured guides…');
    expect(screen.getByText(/full-text search is available after you open any guide/i)).toBeVisible();
    fireEvent.change(search, { target: { value: 'backup' } });

    expect(screen.getByRole('heading', { level: 3, name: 'Search results' })).toBeVisible();
    expect(screen.getByText(/across the featured guide directory/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /health, backup, and recovery/i })).toHaveAttribute(
      'href',
      '/docs/0.1/operations/health-backup/',
    );
    expect(screen.getAllByText('Deploy & operate').length).toBeGreaterThan(0);

    fireEvent.change(search, { target: { value: 'no-such-guide-phrase' } });
    expect(screen.getByText('No matching guidance')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('heading', { level: 3, name: 'Use the product' })).toBeVisible();
  });

  it('keeps GitHub as a secondary source and development action only', () => {
    renderDocs();

    const source = screen.getByRole('link', {
      name: 'View the matching documentation source on GitHub',
    });
    expect(source).toHaveAttribute('href', DEVELOPMENT_DOCS_URL);
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', expect.stringContaining('noopener'));

    const guideLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('#docs-results a'));
    expect(guideLinks.length).toBeGreaterThan(0);
    for (const link of guideLinks) {
      expect(link.getAttribute('href')).toMatch(/^\/docs\/0\.1\//);
    }

    expect(screen.queryByRole('link', { name: /latest stable/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Stable site publishes with the first Stable release/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /development source/i })).toHaveAttribute(
      'href',
      DEVELOPMENT_DOCS_URL,
    );
  });

  it('derives stable documentation lines and sanitized article routes', () => {
    expect(docsVersionLine('2.4.19')).toBe('2.4');
    expect(docsVersionLine('custom')).toBe('development');
    expect(docsArticleUrl('/analyst/cases/', '2.4.19')).toBe('/docs/2.4/analyst/cases/');
    expect(documentationSourceUrl(testingRelease)).toBe(DEVELOPMENT_DOCS_URL);
    expect(documentationSourceUrl({ ...testingRelease, version: '2.4.19', channel: 'stable' }))
      .toBe('https://github.com/ARYDESTROYER/Agentic-Kibana/tree/v2.4.19/docs');
  });

  it('offers the public Stable site only from an explicitly Stable Console build', () => {
    renderDocs({
      releaseIdentity: { ...testingRelease, channel: 'stable' },
      backendInfo: {
        version: testingRelease.version,
        release_channel: 'stable',
        commit_sha: testingRelease.commitSha,
        build_time: testingRelease.buildTime,
      },
    });

    expect(screen.getByRole('link', { name: /latest stable/i })).toHaveAttribute(
      'href',
      PUBLIC_STABLE_DOCS_URL,
    );
  });

  it('fails safe to Testing when the Console and backend build identities disagree', () => {
    renderDocs({
      releaseIdentity: { ...testingRelease, channel: 'stable' },
      backendInfo: {
        version: testingRelease.version,
        release_channel: 'testing',
        commit_sha: testingRelease.commitSha,
        build_time: testingRelease.buildTime,
      },
    });

    expect(screen.getByTestId('docs-release-line')).toHaveTextContent(/· Testing$/);
    expect(
      screen.getByText(/Console and backend build identities differ/i),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: /latest stable/i })).not.toBeInTheDocument();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = renderDocs();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Help Center on the Round 14 console grammar (HC1 to HC3)', () => {
  it('heads the page with a help tip and no breadcrumb, icon, description or pill', () => {
    const { container } = renderDocs();
    expect(screen.getByRole('button', { name: 'About Help Center' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /breadcrumb/i })).toBeNull();
    expect(screen.queryByText(/Guidance for using, administering/)).toBeNull();
    // PageContainer owns the rhythm: no space-y on the page root.
    expect(screen.getByTestId('docs-page').className).not.toMatch(/space-y-/);
    expect(container.querySelector('[data-page-header] svg.lucide-book-open-text')).toBeNull();
  });

  it('puts the directory and the other versions in panels', () => {
    renderDocs();
    expect(screen.getByRole('region', { name: 'Find guidance' })).toHaveClass('surface-panel');
    expect(screen.getByRole('region', { name: 'Other documentation versions' })).toHaveClass('surface-panel');
  });

  it('marks the selected category like the selected navigation item, with no border', () => {
    renderDocs();
    const selected = screen.getByRole('button', { name: /use the product/i });
    expect(selected).toHaveAttribute('aria-current', 'page');
    expect(selected).toHaveAttribute('data-active');
    expect(selected).toHaveClass('text-primary');
    expect(selected.className).not.toMatch(/border-l-2|border-primary/);
  });

  it('makes the whole guide row the link, without an "Open guide" label on every row', () => {
    renderDocs();
    expect(screen.queryByText('Open guide')).toBeNull();
    const link = screen.getByRole('link', { name: /case manager/i });
    expect(link).toHaveTextContent('Work the split queue');
  });

  it('labels search results by category in sentence case, never tracked capitals', () => {
    renderDocs();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documentation' }), {
      target: { value: 'backup' },
    });
    const label = screen.getAllByText('Deploy & operate')[0];
    expect(label.className).not.toMatch(/uppercase|tracking-/);
  });
});
