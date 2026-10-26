/**
 * NoiseFunnel, Round 14 (SPEC §4.3.2 and §4.3.4): what the Overview's removed "Alert flow"
 * band caption said now lives inside the flow's own panel.
 *
 *   - `caption`: the window ("last 24 hours") as 13px muted text after the title and its
 *     help, BESIDE the `h2` so the heading keeps the module's name.
 *   - `crossReference`: a quiet line tying the flow to a figure above it ("Same count as
 *     Total cases above."), on the scale row under the simple flow and closing the
 *     detailed view; never shown while the funnel body is hidden.
 *   - `headingId`: the `h2` id, so the host's panel can be the region the heading names.
 *     The full-screen inspection renders its own funnel without it, so the id stays unique.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NoiseFunnel } from '../NoiseFunnel';
import type { NoiseReduction } from '@/lib/types';

function fixture(): NoiseReduction {
  return {
    window_hours: 24,
    generated_at: '2026-10-26T09:00:00Z',
    bands: ['critical', 'high', 'medium', 'low', 'info'],
    stages: [
      { key: 'ingested', label: 'Ingested', source: 'counters', deterministic: true, total: 1000, by_severity: {} },
      { key: 'clustered', label: 'Clustered', source: 'counters', deterministic: true, total: 220, by_severity: {} },
      { key: 'cases', label: 'Cases opened', source: 'cases', deterministic: false, total: 40, by_severity: {} },
      { key: 'auto_cleared', label: 'Auto-cleared', source: 'cases', deterministic: true, total: 25, by_severity: {} },
      { key: 'escalated', label: 'Escalated', source: 'cases', deterministic: true, total: 15, by_severity: {} },
      { key: 'closed', label: 'Closed by human', source: 'cases', deterministic: true, total: 7, by_severity: {} },
    ],
    drops: { suppressed: 0, ignored: 0 },
    reduction: { overall_pct: 96, human_reduction_pct: 87 },
    counters: { available: true, since: '2026-10-25T00:00:00Z', incomplete: false },
    cases_meta: { truncated: false, store_total: 40, fetched: 40 },
  };
}

const CROSS_REFERENCE = 'Same count as Total cases above.';

describe('NoiseFunnel: window caption, cross-reference and heading id (Round 14)', () => {
  it('renders nothing new when none of the three props is given', () => {
    render(<NoiseFunnel data={fixture()} variant="flat" />);
    const heading = screen.getByRole('heading', { name: 'Noise reduction flow' });
    expect(heading).not.toHaveAttribute('id');
    expect(screen.queryByTestId('window-caption')).toBeNull();
    expect(screen.queryByTestId('noise-cross-reference')).toBeNull();
  });

  it('puts the window after the title and its help, beside the heading, never inside it', () => {
    render(<NoiseFunnel data={fixture()} variant="flat" caption="last 24 hours" />);
    const heading = screen.getByRole('heading', { name: 'Noise reduction flow' });
    const caption = screen.getByTestId('window-caption');
    expect(caption).toHaveTextContent(/^last 24 hours$/);
    expect(heading).not.toContainElement(caption);
    // One title row: the heading and its help first, then the caption, which moves under
    // them as one flex item when the panel is narrow. It follows the design system
    // Panel's caption rule (13px muted, `min-w-0`): it wraps its own words only in a panel
    // narrower than itself, never overflowing it, and carries no tabular figures.
    const row = caption.parentElement!;
    expect(row).toContainElement(heading);
    expect(row).toHaveClass('flex', 'flex-wrap', 'items-baseline');
    expect(caption).toHaveClass('min-w-0', 'text-sm', 'text-muted-foreground');
    expect(caption).not.toHaveClass('whitespace-nowrap');
    expect(caption).not.toHaveClass('tabular-nums');
    const help = screen.getByRole('button', { name: /What the noise-reduction funnel means/i });
    expect(heading.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('gives the heading the host id so the host panel can be the region it names', () => {
    render(
      <section aria-labelledby="flow-title">
        <NoiseFunnel data={fixture()} variant="flat" headingId="flow-title" />
      </section>,
    );
    const heading = screen.getByRole('heading', { name: 'Noise reduction flow' });
    expect(heading).toHaveAttribute('id', 'flow-title');
    expect(screen.getByRole('region', { name: 'Noise reduction flow' })).toContainElement(heading);
  });

  it('keeps the id unique: the full-screen inspection funnel renders without it', async () => {
    const user = userEvent.setup();
    render(<NoiseFunnel data={fixture()} variant="flat" expandable headingId="flow-title" caption="last 24 hours" />);
    await user.click(screen.getByRole('button', { name: 'Open full-screen noise reduction flow' }));
    const dialog = await screen.findByTestId('noise-funnel-expanded');
    expect(within(dialog).getByRole('heading', { name: 'Noise reduction flow' })).not.toHaveAttribute('id');
    expect(document.querySelectorAll('#flow-title')).toHaveLength(1);
  });

  it('rides the cross-reference on the simple view’s scale row', () => {
    render(<NoiseFunnel data={fixture()} variant="flat" crossReference={CROSS_REFERENCE} />);
    const line = screen.getByTestId('noise-cross-reference');
    expect(line).toHaveTextContent(CROSS_REFERENCE);
    // No line of its own under the flow: it shares the square-root scale row.
    expect(screen.getByTestId('noise-share-disclosure')).toContainElement(line);
    expect(screen.getAllByTestId('noise-cross-reference')).toHaveLength(1);
    // The separating dot is its own decorative item; the sentence itself is exactly the
    // host's words. Before anything is laid out, the dot shows (the joined form).
    expect(line.textContent).toBe(CROSS_REFERENCE);
    const dot = line.previousElementSibling;
    expect(dot).toBe(screen.getByTestId('noise-cross-reference-separator'));
    expect(dot).toHaveAttribute('aria-hidden');
    expect(dot).toHaveTextContent(/^·$/);
    expect(dot).toHaveAttribute('data-wrapped', 'false');
    expect(dot).not.toHaveClass('invisible');
  });

  it('closes the detailed view with the cross-reference, which has no scale row', async () => {
    const user = userEvent.setup();
    render(<NoiseFunnel data={fixture()} variant="flat" crossReference={CROSS_REFERENCE} />);
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    const line = screen.getByTestId('noise-cross-reference');
    expect(line).toHaveTextContent(CROSS_REFERENCE);
    expect(screen.getByTestId('noise-detailed-view')).not.toContainElement(line);
    expect(screen.getAllByTestId('noise-cross-reference')).toHaveLength(1);
  });

  it('shows no cross-reference while the funnel body is hidden; the caption stays', () => {
    render(
      <NoiseFunnel
        data={fixture()}
        variant="flat"
        hidden
        onToggleHidden={() => undefined}
        caption="last 24 hours"
        crossReference={CROSS_REFERENCE}
      />,
    );
    expect(screen.queryByTestId('noise-cross-reference')).toBeNull();
    expect(screen.getByTestId('window-caption')).toHaveTextContent('last 24 hours');
  });

  it('keeps its new copy plain: no em dash', () => {
    render(
      <NoiseFunnel data={fixture()} variant="flat" caption="last 24 hours" crossReference={CROSS_REFERENCE} />,
    );
    for (const el of [screen.getByTestId('window-caption'), screen.getByTestId('noise-cross-reference')]) {
      expect(el.textContent ?? '').not.toMatch(/[–—]/);
    }
  });

  it('words the counters-warming note without an em dash', async () => {
    const user = userEvent.setup();
    // Counters not yet available: the funnel falls back to its case-based form, and the
    // detailed view says so where its headline would be.
    const data: NoiseReduction = {
      ...fixture(),
      counters: { available: false, since: null, incomplete: true },
      reduction: { overall_pct: '—', human_reduction_pct: '—' },
    };
    render(<NoiseFunnel data={data} variant="flat" animate={false} />);
    await user.click(screen.getByRole('radio', { name: 'Detailed' }));
    const note = screen.getByTestId('noise-funnel-warming');
    expect(note).toHaveTextContent('Counters warming up, showing the case-based funnel');
    expect(note.textContent ?? '').not.toMatch(/[–—]/);
  });
});

/**
 * The scale row wraps on a narrow panel (a phone shows "Stage rail · flow order (?) ·"
 * then the sentence). A separator must never dangle at a line end or open a line: the
 * dot shows only while the sentence shares the line of the item before it. jsdom lays
 * nothing out, so each test places the two boxes itself.
 */
describe('NoiseFunnel: the cross-reference separator follows the line the sentence is on', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Lay out the help button (the item before the dot) and the sentence. */
  function placeBoxes(sentenceTop: number) {
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'noise-cross-reference') return rect(sentenceTop, 20);
      if (this.getAttribute('aria-label') === 'How to read these counts and percentages') return rect(0, 24);
      return rect(0, 0);
    });
  }

  it('hides the dot when the sentence starts the next line, keeping its box', () => {
    placeBoxes(24);
    render(<NoiseFunnel data={fixture()} variant="flat" crossReference={CROSS_REFERENCE} />);
    const dot = screen.getByTestId('noise-cross-reference-separator');
    expect(dot).toHaveAttribute('data-wrapped', 'true');
    // `visibility: hidden`, never `display: none`: the row cannot reflow and pull the
    // sentence back beside it.
    expect(dot).toHaveClass('invisible');
    expect(dot).not.toHaveClass('hidden');
    expect(screen.getByTestId('noise-cross-reference')).toHaveTextContent(CROSS_REFERENCE);
  });

  it('shows the dot while the sentence sits on the same line as the help before it', () => {
    placeBoxes(2);
    render(<NoiseFunnel data={fixture()} variant="flat" crossReference={CROSS_REFERENCE} />);
    const dot = screen.getByTestId('noise-cross-reference-separator');
    expect(dot).toHaveAttribute('data-wrapped', 'false');
    expect(dot).not.toHaveClass('invisible');
  });
});
