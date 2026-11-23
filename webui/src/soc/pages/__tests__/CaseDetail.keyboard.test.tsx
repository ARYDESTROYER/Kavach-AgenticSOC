/**
 * CaseDetail — keyboard and focus details from the Round 12 review of the Case Manager:
 *
 * - a single-letter shortcut never fires while a letter-consuming control has focus
 *   (a Select's typeahead, a menu, a radio group) — "c" on a filter used to pick
 *   Critical AND open the Close dialog;
 * - the Details sheet opens on its heading (no help tip opening by itself) and closes
 *   back to the Details button, not <body>;
 * - the title row wraps its actions below the title instead of squeezing the title.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const CASE = {
  case_id: 'c-key-1',
  case_number: 'CASE-2026-0400',
  title: 'ip:198.51.100.42 — Entra ID Protection: password spray against many accounts in a short window',
  status: 'open',
  verdict: 'NEEDS_HUMAN',
  risk_score: 55,
  severity_band: 'high',
  updated_at: '2026-10-10T10:00:00Z',
  created_at: '2026-10-10T09:00:00Z',
  history: [],
};

vi.mock('@/lib/api', () => {
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(CASE)),
  };
  return {
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useCan: () => () => true,
}));

import { CaseDetail } from '@/soc/pages/CaseDetail';

function Host() {
  return (
    <div>
      {/* A stand-in for the queue's Radix Select trigger (role=combobox). */}
      <button type="button" role="combobox" aria-expanded="false" aria-controls="none" aria-label="Severity filter">
        Severity
      </button>
      <CaseDetail caseId={CASE.case_id} presentation="embedded" onClose={() => undefined} />
    </div>
  );
}

async function renderLoaded() {
  render(<Host />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent(/password spray/));
}

describe('CaseDetail keyboard model', () => {
  it('a letter typed on a Select trigger never also opens a case dialog', async () => {
    await renderLoaded();
    const filter = screen.getByRole('combobox', { name: 'Severity filter' });
    act(() => filter.focus());
    fireEvent.keyDown(filter, { key: 'c' });
    expect(screen.queryByTestId('confirm-action-dialog')).toBeNull();

    // The same key outside a letter consumer still opens the Close dialog.
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(await screen.findByTestId('confirm-action-dialog')).toBeInTheDocument();
  });

  it('opens the Details sheet on its heading and closes it back to the Details button', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const details = screen.getByRole('button', { name: 'Details' });
    await user.click(details);
    const heading = await screen.findByRole('heading', { name: 'Case facts' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Case facts' })).toBeNull());
    await waitFor(() => expect(details).toHaveFocus());
  });

  it('T opens the tag editor in the facts rail column beside the tabs (D8.2)', async () => {
    await renderLoaded();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 't' });
    const field = await screen.findByRole('textbox', { name: 'New tag' });
    // The editor opened from the rail column, and no Details sheet was needed.
    expect(screen.queryByRole('heading', { name: 'Case facts' })).toBeNull();
    expect(within(screen.getByTestId('case-facts-column')).getByTestId('case-detail-tags')).toBeInTheDocument();
    // The editor is a popover dialog anchored to the rail's "Edit tags".
    await waitFor(() => expect(field.closest('[role="dialog"]')).not.toBeNull());
  });

  it('T opens the Details sheet first when the rail column is hidden, then the tag editor (D8.2, [ru] M4)', async () => {
    const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
    const original = proto.checkVisibility;
    // A narrow pane: the container query hides the rail column.
    proto.checkVisibility = function checkVisibility(this: HTMLElement) {
      return this.getAttribute('data-testid') !== 'case-facts-column';
    };
    try {
      await renderLoaded();
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      fireEvent.keyDown(document.body, { key: 't' });
      expect(await screen.findByRole('heading', { name: 'Case facts' })).toBeInTheDocument();
      const field = await screen.findByRole('textbox', { name: 'New tag' });
      // The editor is the one in the sheet, not in the hidden column.
      expect(screen.getByTestId('case-facts-column')).not.toContainElement(field);
    } finally {
      if (original) proto.checkVisibility = original;
      else delete proto.checkVisibility;
    }
  });

  it('wraps the actions below a long title instead of squeezing it', async () => {
    await renderLoaded();
    const row = screen.getByTestId('case-title-row');
    expect(row).toHaveClass('flex-wrap');
    // The title cell wraps on its NATURAL width (flex-basis auto), never shrunk below it
    // to keep the actions beside it.
    expect(screen.getByTestId('case-title-cell')).toHaveClass('flex-auto', 'min-w-0', 'max-w-full');
  });
});
