/**
 * Entity investigation, Round 14 (SPEC §3.3, §4.9.4).
 *
 * Pins: the header's "View cases" is a link (`<a href>`), not a button that changes the
 * hash, so it opens in a new tab and is announced as a link, while a plain click still
 * goes through the router; and the form's Run button shares its row's label line, so it
 * lines up with the Entity type, value and Lookback controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

const { getSettingsMock } = vi.hoisted(() => ({ getSettingsMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, getSettings: getSettingsMock } };
});

// The case detail sheet is unrelated to these checks.
vi.mock('@/soc/pages/CaseDetail', () => ({ CaseDetail: () => null }));

import { TooltipProvider } from '@/ui/tooltip';
import Workspace from '../Workspace';
import Investigate from '../Investigate';

beforeEach(() => {
  getSettingsMock.mockReset().mockResolvedValue({ prefs: {} });
  sessionStorage.clear();
});

afterEach(() => sessionStorage.clear());

describe('Entity investigation header', () => {
  it('offers "View cases" as a link the router follows on a plain click', async () => {
    const navigate = vi.fn();
    render(
      <TooltipProvider>
        <Workspace tab="investigate" onNavigate={navigate} />
      </TooltipProvider>,
    );
    const header = screen.getByRole('heading', { level: 1, name: 'Entity investigation' }).closest('[data-page-header]');
    const link = within(header as HTMLElement).getByRole('link', { name: 'View cases' });
    expect(link).toHaveAttribute('href', '#/cases');
    expect(within(header as HTMLElement).queryByRole('button', { name: 'View cases' })).toBeNull();

    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('cases');

    // A modified click keeps the browser's own behaviour (a new tab or window).
    navigate.mockClear();
    fireEvent.click(link, { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
    // Let the lazy Investigate panel settle before the test ends.
    await screen.findByRole('textbox', { name: /IP to investigate/i });
  });
});

describe('Entity investigation form', () => {
  it('reserves the Run button\'s label line with a block around an inline label, like its neighbours', () => {
    render(
      <TooltipProvider>
        <Investigate onNavigate={vi.fn()} />
      </TooltipProvider>,
    );
    const spacer = screen.getByTestId('investigate-run-spacer');
    // The other cells' labels are inline in their div's line box; a bare block label
    // (leading-none) made a shorter row and lifted the button 7px.
    expect(spacer.tagName).toBe('DIV');
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
    expect(spacer).toHaveClass('invisible', 'hidden', 'md:block');
    const label = spacer.firstElementChild as HTMLElement;
    expect(label.tagName).toBe('LABEL');
    expect(label.className).not.toMatch(/\bblock\b/);
    expect(spacer.nextElementSibling).toBe(screen.getByRole('button', { name: /run investigation/i }));
  });
});
