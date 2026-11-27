/**
 * Focus on a Runbooks view switch (Round 16 bug hunt B77, WP15F).
 *
 * The library and a runbook share one route (#/runbooks and #/runbooks?id=...), so the link
 * that was used unmounts with the view it lived in and focus fell to the page body with
 * nothing announced. As on Dashboards: opening a runbook from the library tells the editor to
 * land on its heading once it shows; going back lands on the row of the runbook just left
 * (else the library heading). The first view (a fresh load, a link from another page) moves
 * nothing. The editor is a stub here; RunbookEditor.test.tsx covers its half.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listRunbookLibrary: vi.fn(),
  getRunbookMetrics: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', () => ({
  listRunbookLibrary: mocks.listRunbookLibrary,
  getRunbookMetrics: mocks.getRunbookMetrics,
  importRunbook: vi.fn(),
  exportRunbookMarkdown: vi.fn(),
}));

vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: () => true };
});

vi.mock('@/soc/runbooks/editor/RunbookEditor', () => ({
  default: (props: { runbookId: string; landOnHeading?: boolean }) => (
    <div data-testid="editor-stub" data-land={String(Boolean(props.landOnHeading))}>
      <h1>{`Runbook ${props.runbookId}`}</h1>
    </div>
  ),
}));

import { RouterProvider } from '@/soc/router';
import { TooltipProvider } from '@/ui/tooltip';

import Runbooks from '../Runbooks';
import { makeSummary } from '@/soc/runbooks/editor/__tests__/fixtures';

const LIBRARY = [
  makeSummary({ id: 'brute-force-password-spray', title: 'Brute force and password spray', origin: 'builtin', state: 'published', draft_version: null, live_version: 1 }),
  makeSummary({ id: 'phishing-triage', title: 'Phishing triage', origin: 'operator', state: 'draft', live_version: null, draft_version: 1 }),
];

function renderPage() {
  return render(
    <TooltipProvider>
      <RouterProvider>
        <Runbooks />
      </RouterProvider>
    </TooltipProvider>,
  );
}

async function goTo(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  window.location.hash = '#/runbooks';
  mocks.listRunbookLibrary.mockReset().mockResolvedValue({ runbooks: LIBRARY, migration: null });
  mocks.getRunbookMetrics.mockReset().mockRejectedValue(new Error('not needed'));
});

afterEach(() => {
  window.location.hash = '';
});

describe('Runbooks focus on a view switch (B77)', () => {
  it('asks the editor to land on its heading after an open from the library', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: 'Phishing triage' });
    link.focus();
    fireEvent.click(link);
    expect(await screen.findByTestId('editor-stub')).toHaveAttribute('data-land', 'true');
  });

  it('moves nothing on a first view of a runbook (a fresh load or a link from another page)', async () => {
    window.location.hash = '#/runbooks?id=phishing-triage';
    renderPage();
    expect(await screen.findByTestId('editor-stub')).toHaveAttribute('data-land', 'false');
  });

  it('lands on the row of the runbook just left when going back to the library', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('link', { name: 'Phishing triage' }));
    await screen.findByTestId('editor-stub');
    // Back (or "All runbooks"): the editor and the control used go away.
    await goTo('#/runbooks');
    const row = await screen.findByRole('link', { name: 'Phishing triage' });
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('lands on the phone row of the runbook just left', async () => {
    // A phone lists the runbooks as rows (no table), whose title link has no id attribute.
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: /max-width:\s*767px/.test(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      renderPage();
      const link = await screen.findByRole('link', { name: 'Phishing triage' });
      expect(link).not.toHaveAttribute('data-runbook-link');
      fireEvent.click(link);
      await screen.findByTestId('editor-stub');
      await goTo('#/runbooks');
      const row = await screen.findByRole('link', { name: 'Phishing triage' });
      await waitFor(() => expect(document.activeElement).toBe(row));
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it('lands on the library heading when the runbook left is not listed', async () => {
    window.location.hash = '#/runbooks?id=discarded-draft';
    renderPage();
    await screen.findByTestId('editor-stub');
    await goTo('#/runbooks');
    await screen.findByRole('link', { name: 'Phishing triage' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Runbooks' })));
  });

  it('lands on the library heading when the library could not be read', async () => {
    mocks.listRunbookLibrary.mockReset().mockRejectedValue(new Error('library down'));
    window.location.hash = '#/runbooks?id=phishing-triage';
    renderPage();
    await screen.findByTestId('editor-stub');
    // The editor's own read of the library failed too; give it time to settle.
    await waitFor(() => expect(mocks.listRunbookLibrary).toHaveBeenCalled());
    await goTo('#/runbooks');
    await screen.findByText('Could not load the runbooks');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Runbooks' })));
  });

  it('leaves focus alone when it is still on a control', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('link', { name: 'Phishing triage' }));
    await screen.findByTestId('editor-stub');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    try {
      await goTo('#/runbooks');
      await screen.findByRole('link', { name: 'Phishing triage' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });
});
