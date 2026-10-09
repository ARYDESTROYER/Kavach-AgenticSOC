/**
 * EmptyState (SPEC §10.5): the capability line, a starter grid filtered so a card
 * shows only when every tool it needs is allowed, an icon per id, cards that hand the
 * starter to the host, static geometry while the context loads, the access link, the
 * compact case variant, hostile text rendered as text (#9), and axe.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import type { ChatStarter } from '@/lib/types';
import { makeContext } from '../../composer/__tests__/fixtures';
import { CAPABILITY_LINE, EmptyState, visibleStarters } from '../EmptyState';
import { STARTER_ICONS, starterIcon } from '../starter-icons';

expect.extend(toHaveNoViolations);

const STARTERS: ChatStarter[] = [
  { id: 'investigate', label: 'Investigate', description: 'Walk through case-0042, the newest open case', prompt: 'Investigate case-0042.', tools: ['get_case'] },
  { id: 'hunt', label: 'Hunt an indicator', description: 'Search logs, cases and intel for one value', prompt: 'Help me hunt an indicator in Wazuh over the last 24h.', tools: ['search_logs', 'lookup_indicator'] },
  { id: 'posture', label: 'Posture now', description: 'Key metrics and trends', prompt: 'How is our posture right now?', tools: ['soc_metrics'] },
  { id: 'shift_brief', label: 'Shift brief', description: 'Open work and next steps', prompt: 'Write a shift brief.', tools: ['shift_report'] },
  { id: 'explain_metric', label: 'Explain a metric', description: 'What a KPI means', prompt: 'Explain the FP rate.', tools: ['soc_metrics', 'app_help'] },
  { id: 'learn_app', label: 'Learn the app', description: 'How this console works', prompt: 'How do I add a model?', tools: ['app_help'] },
];

describe('visibleStarters', () => {
  it('keeps a starter only when all its tools are allowed', () => {
    const ctx = makeContext({ starters: STARTERS }, { lookup_indicator: 'enrichment:read', soc_metrics: 'metrics:view' });
    expect(visibleStarters(ctx).map((s) => s.id)).toEqual(['investigate', 'shift_brief', 'learn_app']);
    expect(visibleStarters(null)).toEqual([]);
  });

  it('hides a starter whose tool the deployment switched off (allowed, available: false)', () => {
    const base = makeContext({ starters: STARTERS });
    const ctx = { ...base, tools: base.tools.map((t) => (t.name === 'lookup_indicator' ? { ...t, available: false } : t)) };
    const ids = visibleStarters(ctx).map((s) => s.id);
    expect(ids).not.toContain('hunt');
    expect(ids).toContain('investigate');
  });
});

describe('EmptyState', () => {
  it('shows the capability line and the six starters with icons, and sends the clicked one', async () => {
    const onStarter = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<EmptyState context={makeContext({ starters: STARTERS })} onStarter={onStarter} />);
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Suggested questions' });
    const cards = within(list).getAllByRole('button');
    expect(cards).toHaveLength(6);
    expect(cards[0]).toHaveAccessibleName(/Investigate.*Walk through case-0042/);
    for (const card of cards) expect(card.querySelector('svg')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /Shift brief/ }));
    expect(onStarter).toHaveBeenCalledWith(STARTERS[3]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the cards compact: one line each for label and description', () => {
    render(<EmptyState context={makeContext({ starters: STARTERS })} onStarter={() => {}} />);
    const card = screen.getByRole('button', { name: /Investigate/ });
    expect(card.className).toContain('max-h-16');
    const spans = card.querySelectorAll('span.truncate');
    expect(spans).toHaveLength(2);
    expect(spans[1]).toHaveAttribute('title', STARTERS[0].description);
  });

  it('switches to one column below 560 px of lane width (container query)', () => {
    render(<EmptyState context={makeContext({ starters: STARTERS })} onStarter={() => {}} />);
    expect(screen.getByRole('region', { name: 'Start a conversation' }).className).toContain('@container');
    expect(screen.getByRole('list').className).toMatch(/grid-cols-1 .*@\[560px\]:grid-cols-2/);
  });

  it('reserves the grid while the context loads and offers no card', () => {
    const { container } = render(<EmptyState context={null} onStarter={() => {}} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(container.querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(6);
  });

  it('says the context could not be loaded, with Retry, instead of endless skeletons', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<EmptyState context={null} error="HTTP 503" onRetry={onRetry} onStarter={() => {}} />);
    expect(screen.getByText(CAPABILITY_LINE)).toBeInTheDocument();
    expect(screen.getByText("Couldn't load what the assistant can access.")).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(0);
    // The access link would only repeat the failure.
    expect(screen.queryByRole('button', { name: 'What can the assistant access?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the last good context when only a refresh failed', () => {
    render(<EmptyState context={makeContext({ starters: STARTERS })} error="HTTP 503" onStarter={() => {}} />);
    expect(screen.getByRole('list', { name: 'Suggested questions' })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load what the assistant can access.")).toBeNull();
  });

  it('shows the error in the case variant\'s access popover', async () => {
    const user = userEvent.setup();
    render(<EmptyState context={null} error="HTTP 503" onRetry={() => {}} onStarter={() => {}} variant="case" />);
    await user.click(screen.getByRole('button', { name: 'What can the assistant access?' }));
    const dialog = await screen.findByRole('dialog', { name: 'What the assistant can access' });
    expect(within(dialog).getByText("Couldn't load what the assistant can access.")).toBeInTheDocument();
  });

  it('disables the cards when the host cannot send', () => {
    render(<EmptyState context={makeContext({ starters: STARTERS })} onStarter={() => {}} disabled />);
    for (const card of screen.getAllByRole('button', { name: /Investigate|Hunt|Posture|Shift|Explain|Learn/ })) {
      expect(card).toBeDisabled();
    }
  });

  it('opens the access popover from the link', async () => {
    const user = userEvent.setup();
    render(<EmptyState context={makeContext({ starters: [] }, { cost_usage: 'cost:view' })} onStarter={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'What can the assistant access?' }));
    const dialog = await screen.findByRole('dialog', { name: 'What the assistant can access' });
    expect(within(dialog).getByText('Needs cost:view')).toBeInTheDocument();
  });

  it('renders the compact case variant without a grid', async () => {
    const { container } = render(
      <EmptyState context={makeContext({ starters: STARTERS })} onStarter={() => {}} variant="case" />,
    );
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText(/Ask about this case/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'What can the assistant access?' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders server text as text', () => {
    const hostile: ChatStarter = { id: 'investigate', label: '<b>x</b>', description: '<img src=x>', prompt: 'p', tools: [] };
    const { container } = render(<EmptyState context={makeContext({ starters: [hostile] })} onStarter={() => {}} />);
    expect(container.querySelector('b, img')).toBeNull();
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument();
  });
});

describe('starter icons', () => {
  it('maps every known id and falls back for an unknown one', () => {
    expect(Object.keys(STARTER_ICONS).sort()).toEqual(
      ['explain_metric', 'hunt', 'investigate', 'learn_app', 'posture', 'shift_brief'].sort(),
    );
    expect(starterIcon('mystery')).toBeTruthy();
  });
});
