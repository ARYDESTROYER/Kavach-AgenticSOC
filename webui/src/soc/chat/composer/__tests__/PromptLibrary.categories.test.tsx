/**
 * The prompt library dialog's Round 13 additions (SPEC-chat §5.2, T30, T35), on the
 * dialog alone: `categories` opens it filtered to a start-screen pill (Hunt covers Hunt
 * and IOC, both chips pressed; any chip returns to the usual filters), the one-line
 * description, the row as Use, the bottom fade only while more rows are below, and UK
 * "Favourites".
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => vi.fn() }));

import type { ChatPrompt, ChatPromptCategory } from '@/lib/types';
import { LIBRARY_DESCRIPTION, PromptLibraryDialog } from '../PromptLibrary';
import { filterPrompts, visibleStarters } from '../prompt-library';
import type { SavedPromptsController } from '../SavedPrompts';
import { makeContext } from './fixtures';

const OWN: ChatPrompt[] = [
  { id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins for {user} this week?', category: 'hunt' },
  { id: 'p2', title: 'Phishing review', text: 'Summarise phishing cases.', favorite: true, category: 'triage' },
];

function controller(prompts: ChatPrompt[] = OWN): SavedPromptsController {
  return {
    prompts,
    state: 'ready',
    error: null,
    load: vi.fn(),
    save: vi.fn(async () => true),
    update: vi.fn(async () => true),
    remove: vi.fn(async () => true),
    saving: false,
    clearError: vi.fn(),
  };
}

function Host({ categories, onUse = vi.fn() }: { categories?: ChatPromptCategory[]; onUse?: () => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <PromptLibraryDialog
      open={open}
      onOpenChange={setOpen}
      controller={controller()}
      context={makeContext()}
      onUse={onUse}
      onCompose={vi.fn()}
      categories={categories}
    />
  );
}

const starterTitles = (dialog: HTMLElement) =>
  within(within(dialog).getByRole('region', { name: 'Starter prompts' }))
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-row-title]')?.textContent);

describe('PromptLibraryDialog — Round 13', () => {
  it('opens filtered to a pill\'s categories, with both chips pressed', async () => {
    render(<Host categories={['hunt', 'ioc']} />);
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    expect(within(dialog).getByRole('button', { name: 'Hunt' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'IOC' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    const expected = filterPrompts(visibleStarters(makeContext()), ['hunt', 'ioc'], '').map((p) => p.title);
    expect(expected.length).toBeGreaterThan(2);
    expect(starterTitles(dialog)).toEqual(expected);
    // The analyst's own prompts follow the same filter.
    const own = within(dialog).getByRole('region', { name: 'Your prompts' });
    expect(within(own).getAllByRole('listitem').map((li) => li.querySelector('[data-row-title]')?.textContent)).toEqual(['VPN anomalies']);
  });

  it('returns to the usual filters when a chip is chosen', async () => {
    const user = userEvent.setup();
    render(<Host categories={['reporting']} />);
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    expect(within(dialog).getByRole('button', { name: 'Reporting' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Reporting' })).toHaveAttribute('aria-pressed', 'false');
    expect(starterTitles(dialog)).toHaveLength(visibleStarters(makeContext()).length);
  });

  it('opens unfiltered without categories', async () => {
    render(<Host />);
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    expect(within(dialog).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says what it is for in one line, writes Favourites, and makes the row itself Use', async () => {
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(<Host onUse={onUse} />);
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    expect(dialog).toHaveAccessibleDescription(LIBRARY_DESCRIPTION);
    expect(within(dialog).getByRole('button', { name: 'Favourites' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Favourite VPN anomalies' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Favorite/)).toBeNull();
    await user.click(within(dialog).getByText('Phishing review'));
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  it('fades the list only while more rows are below', async () => {
    render(<Host />);
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    const list = within(dialog).getByTestId('prompt-library-list');
    // jsdom lays nothing out: nothing is below, so no fade.
    expect(list).not.toHaveAttribute('data-more-below');
    expect(list.className).not.toContain('mask-image');
  });
});
