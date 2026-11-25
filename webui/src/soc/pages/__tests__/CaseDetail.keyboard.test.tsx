/**
 * CaseDetail: keyboard and focus details from the Round 12 review of the Case Manager:
 *
 * - a single-letter shortcut never fires while a letter-consuming control has focus
 *   (a Select's typeahead, a menu, a radio group): "c" on a filter used to pick
 *   Critical AND open the Close dialog;
 * - the inspector sheet (a pane too narrow for the column) opens on its heading (no help
 *   tip opening by itself) and closes back to the "Case facts" toggle, not <body>;
 * - `]` shows or hides the inspector column, keeps the choice per viewer, and honours
 *   `shortcutBlocked` like every other case key (Round 16, WP03);
 * - the title row is one 44px line that never wraps: the title truncates first.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const CASE = {
  case_id: 'c-key-1',
  case_number: 'CASE-2026-0400',
  title: 'ip:198.51.100.42 · Entra ID Protection: password spray against many accounts in a short window',
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

/** A pane narrower than 52rem: the container query hides the probe and the column. */
async function withNarrowPane(run: () => Promise<void>) {
  const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
  const original = proto.checkVisibility;
  proto.checkVisibility = function checkVisibility(this: HTMLElement) {
    const id = this.getAttribute('data-testid');
    return id !== 'case-facts-column' && id !== 'case-inspector-probe';
  };
  try {
    await run();
  } finally {
    if (original) proto.checkVisibility = original;
    else delete proto.checkVisibility;
  }
}

beforeEach(() => {
  window.localStorage.clear();
});

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

  it('opens the inspector sheet on its heading at a narrow pane and closes it back to the toggle', async () => {
    await withNarrowPane(async () => {
      const user = userEvent.setup();
      await renderLoaded();
      const toggle = screen.getByTestId('case-inspector-toggle');
      expect(toggle).toHaveAccessibleName('Case facts');
      // The toggle opens a sheet here, so it is not a pressed/unpressed switch.
      expect(toggle).not.toHaveAttribute('aria-pressed');
      await user.click(toggle);
      const heading = await screen.findByRole('heading', { name: 'Case facts' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(document.querySelector('[role="tooltip"]')).toBeNull();

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Case facts' })).toBeNull());
      await waitFor(() => expect(toggle).toHaveFocus());
    });
  });

  it('] hides and shows the inspector column, kept for the viewer', async () => {
    await renderLoaded();
    const toggle = screen.getByTestId('case-inspector-toggle');
    expect(screen.getByTestId('case-facts-column')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('aria-keyshortcuts', ']');

    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: ']' });
    await waitFor(() => expect(screen.queryByTestId('case-facts-column')).toBeNull());
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem('soc.caseManager.inspector')).toBe('closed');
    // No sheet: the column fits, so the key toggles the column.
    expect(screen.queryByRole('heading', { name: 'Case facts' })).toBeNull();

    fireEvent.click(toggle);
    expect(await screen.findByTestId('case-facts-column')).toBeInTheDocument();
    expect(window.localStorage.getItem('soc.caseManager.inspector')).toBe('open');
  });

  it('starts with the column hidden when the viewer hid it', async () => {
    window.localStorage.setItem('soc.caseManager.inspector', 'closed');
    await renderLoaded();
    expect(screen.queryByTestId('case-facts-column')).toBeNull();
    expect(screen.getByTestId('case-inspector-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('] typed on a letter-consuming control never toggles the inspector (shortcutBlocked)', async () => {
    await renderLoaded();
    const filter = screen.getByRole('combobox', { name: 'Severity filter' });
    act(() => filter.focus());
    fireEvent.keyDown(filter, { key: ']' });
    expect(screen.getByTestId('case-facts-column')).toBeInTheDocument();
    // Nor in a text field.
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      act(() => input.focus());
      fireEvent.keyDown(input, { key: ']' });
      expect(screen.getByTestId('case-facts-column')).toBeInTheDocument();
    } finally {
      input.remove();
    }
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

  it('T opens the inspector sheet first when the pane has no room for the column, then the tag editor (D8.2, [ru] M4)', async () => {
    await withNarrowPane(async () => {
      await renderLoaded();
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      fireEvent.keyDown(document.body, { key: 't' });
      expect(await screen.findByRole('heading', { name: 'Case facts' })).toBeInTheDocument();
      const field = await screen.findByRole('textbox', { name: 'New tag' });
      // The editor is the one in the sheet, not in the hidden column.
      expect(screen.getByTestId('case-facts-column')).not.toContainElement(field);
    });
  });

  it('T opens a hidden column first when it fits, then the tag editor in it', async () => {
    window.localStorage.setItem('soc.caseManager.inspector', 'closed');
    await renderLoaded();
    expect(screen.queryByTestId('case-facts-column')).toBeNull();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 't' });
    const field = await screen.findByRole('textbox', { name: 'New tag' });
    expect(screen.queryByRole('heading', { name: 'Case facts' })).toBeNull();
    expect(screen.getByTestId('case-facts-column')).toBeInTheDocument();
    await waitFor(() => expect(field.closest('[role="dialog"]')).not.toBeNull());
  });

  it('keeps the title row one 44px line: the title truncates before the actions wrap', async () => {
    await renderLoaded();
    const row = screen.getByTestId('case-title-row');
    expect(row).toHaveClass('flex-nowrap', 'h-11');
    expect(row).not.toHaveClass('flex-wrap');
    // The title cell takes the room left and may shrink to nothing; the title truncates.
    expect(screen.getByTestId('case-title-cell')).toHaveClass('min-w-0', 'flex-1');
  });
});
