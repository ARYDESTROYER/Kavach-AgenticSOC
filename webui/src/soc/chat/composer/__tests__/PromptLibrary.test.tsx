/**
 * The prompt library in the composer (Round 12 SPEC §3.1, SYNTHESIS-chat P1-8):
 * categories, the favorites star, search, read-only starter prompts kept apart from the
 * analyst's own, `{param}` values asked for inline before sending (the analyst's own
 * words, `origin: "user"`), promptbooks run step by step with a counter and Stop, and
 * the empty state's "Browse the prompt library" link. Everything is stored in the
 * existing `UserPrefs.chat_prompts` through `/api/prefs/user` (no new endpoint).
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.hoisted(() => vi.fn());
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatPrompt } from '@/lib/types';
import { EmptyState, LIBRARY_LINK } from '../../empty/EmptyState';
import type { ComposerHandle } from '../Composer';
import { PROMPTBOOK_RUNNING_REASON } from '../PromptRunner';
import { resetPromptbookForTests } from '../promptbook-store';
import { Harness, makeSpies, stubServer, type EngineSpies } from './harness';
import { makeContext } from './fixtures';

expect.extend(toHaveNoViolations);

let spies: EngineSpies;
beforeEach(() => {
  spies = makeSpies();
  announce.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  // The running promptbook outlives a composer (SPEC D13): never into the next test.
  resetPromptbookForTests();
});

const OWN: ChatPrompt[] = [
  { id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins for {user} this week?', category: 'hunt' },
  { id: 'p2', title: 'Phishing review', text: 'Summarise phishing cases.', favorite: true, category: 'triage' },
  { id: 'book-b1', title: 'Case triage', text: 'Open case {case id}.\n---\nRelated cases to {case id}?\n---\nWrite next steps.' },
];

function setup(prompts: ChatPrompt[] = OWN.map((p) => ({ ...p })), props: { busy?: boolean } = {}) {
  const server = stubServer({ prompts });
  const user = userEvent.setup();
  const view = render(<Harness spies={spies} context={makeContext()} {...props} />);
  const textarea = screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;
  return { server, user, view, textarea };
}

async function openLibrary(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Composer options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Prompt library/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
  await within(dialog).findByText('VPN anomalies');
  return dialog;
}

const lastPut = (server: ReturnType<typeof stubServer>) =>
  [...server.calls].reverse().find((c) => c.method === 'PUT')?.body as { chat_prompts: ChatPrompt[] } | undefined;

describe('Composer — prompt library', () => {
  it('keeps your prompts (favorites first) apart from read-only starter prompts', async () => {
    const { user } = setup();
    const dialog = await openLibrary(user);
    const own = within(dialog).getByRole('region', { name: 'Your prompts' });
    const starters = within(dialog).getByRole('region', { name: 'Starter prompts' });
    const ownTitles = within(own).getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent);
    expect(ownTitles).toEqual(['Phishing review', 'VPN anomalies', 'Case triage']);
    expect(within(own).getByText('3 of 50')).toBeInTheDocument();
    // Starters can be used or copied, never starred, edited or deleted.
    expect(within(starters).getByRole('button', { name: 'Use Hunt an indicator' })).toBeInTheDocument();
    expect(within(starters).getByRole('button', { name: 'Save a copy of Hunt an indicator' })).toBeInTheDocument();
    expect(within(starters).queryByRole('button', { name: /^Favorite / })).toBeNull();
    expect(within(starters).queryByRole('button', { name: /^More actions/ })).toBeNull();
    // Rows say their category, kind and the values they ask for.
    const book = within(own).getByText('Case triage').closest('li') as HTMLElement;
    expect(within(book).getByTestId('prompt-meta')).toHaveTextContent('Promptbook · 3 steps · Asks for Case id');
    // A promptbook's button reads "Run", and its name starts with what it shows (WCAG 2.5.3).
    expect(within(book).getByRole('button', { name: 'Run Case triage' })).toHaveTextContent('Run');
    expect(within(starters).getByRole('button', { name: 'Run Triage a case' })).toHaveTextContent('Run');
  });

  it('filters by category chip, favorites and search', async () => {
    const { user } = setup();
    const dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Favorites', pressed: false }));
    expect(within(dialog).getByRole('button', { name: 'Favorites' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).queryByRole('region', { name: 'Starter prompts' })).toBeNull();
    expect(within(dialog).getByText('Phishing review')).toBeInTheDocument();
    expect(within(dialog).queryByText('VPN anomalies')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'IOC' }));
    const starters = within(dialog).getByRole('region', { name: 'Starter prompts' });
    expect(within(starters).getByText('Indicator reputation')).toBeInTheDocument();
    expect(within(starters).queryByText('Hunt an indicator')).toBeNull();
    expect(within(dialog).getByText('None of your prompts match.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search prompts' }), 'vpn');
    expect(within(dialog).getByText('VPN anomalies')).toBeInTheDocument();
    expect(within(dialog).queryByText('Phishing review')).toBeNull();
    expect(within(dialog).getByText('No starter prompts match.')).toBeInTheDocument();
  });

  it('stars a prompt through the prefs route and says so', async () => {
    const { user, server } = setup();
    const dialog = await openLibrary(user);
    const star = within(dialog).getByRole('button', { name: 'Favorite VPN anomalies' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await user.click(star);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Favorite VPN anomalies' })).toHaveAttribute('aria-pressed', 'true'));
    const put = lastPut(server);
    expect(put?.chat_prompts.find((p) => p.id === 'p1')).toMatchObject({ favorite: true, category: 'hunt' });
    // The other prompts are written back untouched (order, ids, category).
    expect(put?.chat_prompts.map((p) => p.id)).toEqual(['p1', 'p2', 'book-b1']);
    expect(announce).toHaveBeenCalledWith('Added VPN anomalies to favorites');
  });

  it('asks for the values of a starter prompt inline and sends the filled text as the analyst’s own', async () => {
    const { user, textarea } = setup();
    const dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Use Hunt an indicator' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompt library' })).toBeNull());
    const card = screen.getByTestId('prompt-params');
    expect(within(card).getByRole('heading', { name: 'Hunt an indicator' })).toBeInTheDocument();
    await waitFor(() => expect(within(card).getByRole('textbox', { name: 'Indicator' })).toHaveFocus());
    await user.type(within(card).getByRole('textbox', { name: 'Indicator' }), 'evil.example');
    await user.type(within(card).getByRole('textbox', { name: 'Period' }), '30 days');
    await user.click(within(card).getByRole('button', { name: 'Send' }));
    expect(spies.send).toHaveBeenCalledWith(
      'Hunt for evil.example across logs, cases and threat intel in the last 30 days. What do we know about it?',
      { origin: 'user' },
    );
    expect(screen.queryByTestId('prompt-params')).toBeNull();
    expect(textarea.value).toBe('');
  });

  it('picks a saved prompt with a value from the / menu: the query is cleared and the value asked for', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, '/vpn');
    await user.click(await screen.findByRole('option', { name: /VPN anomalies/ }));
    expect(textarea.value).toBe('');
    const card = await screen.findByTestId('prompt-params');
    await user.type(within(card).getByRole('textbox', { name: 'User' }), 'jdoe{Enter}');
    expect(spies.send).toHaveBeenCalledWith('Any odd VPN logins for jdoe this week?', { origin: 'user' });
  });

  it('closes the values card with Esc without sending, and a prompt without values goes into the field', async () => {
    const { user, textarea } = setup();
    let dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Use VPN anomalies' }));
    const card = await screen.findByTestId('prompt-params');
    await waitFor(() => expect(within(card).getByRole('textbox', { name: 'User' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('prompt-params')).toBeNull();
    expect(spies.send).not.toHaveBeenCalled();
    expect(spies.stop).not.toHaveBeenCalled();

    dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Use Phishing review' }));
    await waitFor(() => expect(textarea.value).toBe('Summarise phishing cases.'));
    expect(screen.queryByTestId('prompt-params')).toBeNull();
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('keeps the filled prompt in its card while an answer is being written, and says why', async () => {
    const { user, textarea } = setup(undefined, { busy: true });
    await user.type(textarea, '/vpn');
    await user.click(await screen.findByRole('option', { name: /VPN anomalies/ }));
    const card = await screen.findByTestId('prompt-params');
    await user.type(within(card).getByRole('textbox', { name: 'User' }), 'jdoe{Enter}');
    expect(spies.send).not.toHaveBeenCalled();
    expect(screen.getByTestId('prompt-params')).toBeInTheDocument();
    const send = within(card).getByRole('button', { name: 'Send' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAccessibleDescription('Wait for the current answer to finish.');
    expect(announce).toHaveBeenCalledWith('Wait for the current answer to finish.');
    expect(textarea.value).toBe('');
  });

  it('names the real reason when a running promptbook blocks a library prompt', async () => {
    const { user, view } = setup();
    let dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Run Case triage' }));
    let card = await screen.findByTestId('prompt-params');
    await user.type(within(card).getByRole('textbox', { name: 'Case id' }), 'case-0042');
    await user.click(within(card).getByRole('button', { name: 'Run 3 steps' }));
    expect(spies.send).toHaveBeenCalledTimes(1);
    // As under the real engine, step 1 is being answered: the engine is busy, and the
    // book sends step 2 the moment it is not. The book, not the answer, is the reason.
    view.rerender(<Harness spies={spies} context={makeContext()} busy />);
    expect(screen.getByTestId('promptbook-bar')).toHaveTextContent('Step 1 of 3');
    dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Use VPN anomalies' }));
    card = await screen.findByTestId('prompt-params');
    await user.type(within(card).getByRole('textbox', { name: 'User' }), 'jdoe{Enter}');
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(within(card).getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(PROMPTBOOK_RUNNING_REASON);
    expect(announce).toHaveBeenCalledWith(PROMPTBOOK_RUNNING_REASON);
    expect(announce).not.toHaveBeenCalledWith(expect.stringMatching(/Send it when the current answer finishes/));
  });

  it('runs a promptbook: one value for every step, step 1 sent, a counter with Stop, sending paused', async () => {
    const { user, textarea } = setup();
    const dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Run Case triage' }));
    const card = await screen.findByTestId('prompt-params');
    expect(within(card).getAllByRole('textbox')).toHaveLength(1);
    await user.type(within(card).getByRole('textbox', { name: 'Case id' }), 'case-0042');
    await user.click(within(card).getByRole('button', { name: 'Run 3 steps' }));
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(spies.send).toHaveBeenCalledWith('Open case case-0042.', { origin: 'user' });
    const bar = screen.getByTestId('promptbook-bar');
    expect(bar).toHaveTextContent('Case triage · Step 1 of 3');
    // The analyst cannot interleave a question while the book runs.
    expect(textarea).toHaveAttribute('placeholder', PROMPTBOOK_RUNNING_REASON);
    await user.click(within(bar).getByRole('button', { name: 'Stop' }));
    expect(screen.getByTestId('promptbook-bar')).toHaveTextContent('Stopped at step 1 of 3.');
    expect(textarea).not.toHaveAttribute('placeholder', PROMPTBOOK_RUNNING_REASON);
    // Focus never falls to the page: Stop became Close, and Close hands it to the field.
    const close = within(screen.getByTestId('promptbook-bar')).getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    await user.click(close);
    expect(screen.queryByTestId('promptbook-bar')).toBeNull();
    expect(textarea).toHaveFocus();
  });

  it('keeps the running book when the composer unmounts and comes back (leaving the chat page)', async () => {
    const { user, view } = setup();
    const dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Run Case triage' }));
    const card = await screen.findByTestId('prompt-params');
    await user.type(within(card).getByRole('textbox', { name: 'Case id' }), 'case-0042');
    await user.click(within(card).getByRole('button', { name: 'Run 3 steps' }));
    view.unmount();
    render(<Harness spies={spies} context={makeContext()} />);
    expect(screen.getByTestId('promptbook-bar')).toHaveTextContent('Case triage · Step 1 of 3');
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveAttribute('placeholder', PROMPTBOOK_RUNNING_REASON);
  });

  it('saves a copy of a starter with its category, as the analyst’s own prompt', async () => {
    const { user, server } = setup([]);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Prompt library/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    expect(await within(dialog).findByText(/No saved prompts yet/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save a copy of Explain a case' }));
    const save = await screen.findByRole('dialog', { name: 'Save prompt' });
    expect(within(save).getByRole('textbox', { name: 'Title' })).toHaveValue('Explain a case');
    expect(within(save).getByRole('combobox', { name: 'Category' })).toHaveTextContent('Triage');
    expect(within(save).getByTestId('save-prompt-params')).toHaveTextContent('Asks for: Case id');
    await user.click(within(save).getByRole('button', { name: 'Save prompt' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save prompt' })).toBeNull());
    const saved = lastPut(server)?.chat_prompts ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: 'Explain a case', category: 'triage' });
    expect(saved[0].id.startsWith('p-')).toBe(true);
  });

  it('saves a promptbook only with two or more steps, under the book id prefix', async () => {
    const { user, server } = setup([]);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Prompt library/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    await user.click(within(dialog).getByRole('button', { name: 'New prompt' }));
    const save = await screen.findByRole('dialog', { name: 'Save prompt' });
    await user.click(within(save).getByRole('radio', { name: 'Promptbook' }));
    const steps = within(save).getByRole('textbox', { name: 'Steps' });
    await user.type(steps, 'Only one step');
    const problem = within(save).getByText(/needs at least 2 steps/);
    expect(problem).toBeInTheDocument();
    // The reason is tied to the field and to the (still focusable) Save button.
    expect(steps).toHaveAttribute('aria-invalid', 'true');
    expect(steps).toHaveAccessibleDescription(expect.stringContaining(problem.textContent ?? ''));
    const saveButton = within(save).getByRole('button', { name: 'Save promptbook' });
    expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    expect(saveButton).toHaveAccessibleDescription(problem.textContent ?? '');
    await user.click(saveButton);
    expect(lastPut(server)).toBeUndefined();
    await user.type(steps, '{Enter}---{Enter}A second step for {{host}');
    expect(within(save).getByTestId('save-prompt-params')).toHaveTextContent('Asks for: Host');
    await user.click(within(save).getByRole('button', { name: 'Save promptbook' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save prompt' })).toBeNull());
    const saved = lastPut(server)?.chat_prompts ?? [];
    expect(saved[0].id.startsWith('book-')).toBe(true);
    expect(saved[0].text).toBe('Only one step\n---\nA second step for {host}');
    // No title typed: it is the first step, not every step flattened with "---".
    expect(saved[0].title).toBe('Only one step');
    expect(announce).toHaveBeenCalledWith('Promptbook saved');
  });

  it('takes a cleared promptbook title from the first step, as the placeholder promises', async () => {
    const { user, server } = setup([]);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Prompt library/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    await user.click(within(dialog).getByRole('button', { name: 'New prompt' }));
    const save = await screen.findByRole('dialog', { name: 'Save prompt' });
    await user.click(within(save).getByRole('radio', { name: 'Promptbook' }));
    fireEvent.change(within(save).getByRole('textbox', { name: 'Steps' }), {
      target: { value: 'Count open cases.\n---\nList the top rules.' },
    });
    const title = within(save).getByRole('textbox', { name: 'Title' });
    await user.type(title, 'Draft title');
    await user.clear(title);
    await user.click(within(save).getByRole('button', { name: 'Save promptbook' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save prompt' })).toBeNull());
    const saved = lastPut(server)?.chat_prompts ?? [];
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe('Count open cases.');
    expect(saved[0].title).not.toContain('---');
  });

  it('edits a saved prompt in place (title, category and text)', async () => {
    const { user, server } = setup();
    const dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'More actions for VPN anomalies' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit prompt' });
    const title = within(edit).getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'VPN sign-ins');
    await user.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit prompt' })).toBeNull());
    const put = lastPut(server);
    expect(put?.chat_prompts.map((p) => p.id)).toEqual(['p1', 'p2', 'book-b1']);
    expect(put?.chat_prompts[0]).toMatchObject({ id: 'p1', title: 'VPN sign-ins', category: 'hunt' });
  });

  it('shows the server’s list when the prompt was deleted in another tab, instead of a row that keeps failing', async () => {
    const { user, server } = setup();
    const dialog = await openLibrary(user);
    // Another tab deletes "VPN anomalies".
    server.prompts = server.prompts.filter((p) => p.id !== 'p1');
    await user.click(within(dialog).getByRole('button', { name: 'Favorite VPN anomalies' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That prompt no longer exists.');
    expect(within(dialog).queryByText('VPN anomalies')).toBeNull();
    expect(within(dialog).getByText('2 of 50')).toBeInTheDocument();
  });

  it('starts each dialog without an earlier action’s error', async () => {
    const server = stubServer({ prompts: OWN.map((p) => ({ ...p })) });
    const user = userEvent.setup();
    const handle = React.createRef<ComposerHandle>();
    render(<Harness spies={spies} context={makeContext()} handleRef={handle} />);
    let dialog = await openLibrary(user);
    server.putStatus = 503;
    await user.click(within(dialog).getByRole('button', { name: 'More actions for VPN anomalies' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Delete VPN anomalies' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/unavailable|could not be deleted/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompt library' })).toBeNull());
    // Save prompt (a past turn's "Save prompt") opens clean.
    act(() => handle.current?.savePrompt('Count failed sign-ins'));
    const save = await screen.findByRole('dialog', { name: 'Save prompt' });
    expect(within(save).queryByRole('alert')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save prompt' })).toBeNull());
    // …and so does the library.
    dialog = await openLibrary(user);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('keeps focus on a favorite star while it saves and after its row moves', async () => {
    const { user } = setup();
    const dialog = await openLibrary(user);
    const star = within(dialog).getByRole('button', { name: 'Favorite Case triage' });
    star.focus();
    await user.keyboard(' ');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Favorite Case triage' })).toHaveAttribute('aria-pressed', 'true'),
    );
    // Favorites sort first: the row moved, and its star still has focus.
    const titles = within(within(dialog).getByRole('region', { name: 'Your prompts' }))
      .getAllByRole('listitem')
      .map((li) => li.querySelector('p')?.textContent);
    expect(titles).toEqual(['Phishing review', 'Case triage', 'VPN anomalies']);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Favorite Case triage' })).toHaveFocus());
    // Never natively disabled while saving (that would drop focus out of the dialog).
    expect(within(dialog).getByRole('button', { name: 'Favorite VPN anomalies' })).not.toBeDisabled();
  });

  it('moves focus on when an un-starred row leaves the Favorites list, never to the dialog', async () => {
    const { user } = setup([
      { id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins for {user} this week?', favorite: true },
      { id: 'p2', title: 'Phishing review', text: 'Summarise phishing cases.', favorite: true },
      { id: 'p3', title: 'Not starred', text: 'Count cases.' },
    ]);
    const dialog = await openLibrary(user);
    await user.click(within(dialog).getByRole('button', { name: 'Favorites', pressed: false }));
    const own = () => within(dialog).getByRole('region', { name: 'Your prompts' });
    const titles = () => within(own()).getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent);
    expect(titles()).toEqual(['VPN anomalies', 'Phishing review']);
    // Un-star the first row: it leaves the list, and focus moves to the next row's star.
    within(dialog).getByRole('button', { name: 'Favorite VPN anomalies' }).focus();
    await user.keyboard(' ');
    await waitFor(() => expect(titles()).toEqual(['Phishing review']));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Favorite Phishing review' })).toHaveFocus());
    expect(announce).toHaveBeenCalledWith('Removed VPN anomalies from favorites');
    // Un-star the last one: no row is left, so focus goes to the search field.
    await user.keyboard(' ');
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Favorite Phishing review' })).toBeNull());
    await waitFor(() => expect(within(dialog).getByRole('searchbox', { name: 'Search prompts' })).toHaveFocus());
    expect(document.activeElement?.getAttribute('role')).not.toBe('dialog');
  });

  it('moves focus through the delete confirmation and never out of the dialog', async () => {
    const { user } = setup();
    const dialog = await openLibrary(user);
    // Delete… focuses Keep (the safe default).
    await user.click(within(dialog).getByRole('button', { name: 'More actions for VPN anomalies' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Keep VPN anomalies' })).toHaveFocus());
    // Keep returns to the row's ⋯.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'More actions for VPN anomalies' })).toHaveFocus());
    // A confirmed delete moves on to the next row's Use.
    await user.click(within(dialog).getByRole('button', { name: 'More actions for VPN anomalies' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Delete VPN anomalies' }));
    await waitFor(() => expect(within(dialog).queryByText('VPN anomalies')).toBeNull());
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Run Case triage' })).toHaveFocus());
  });

  it('focuses the search field when the last prompt is deleted', async () => {
    const { user } = setup([{ id: 'p9', title: 'Only one', text: 'Count cases.' }]);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Prompt library/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    await within(dialog).findByText('Only one');
    await user.click(within(dialog).getByRole('button', { name: 'More actions for Only one' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Delete Only one' }));
    await waitFor(() => expect(within(dialog).getByRole('searchbox', { name: 'Search prompts' })).toHaveFocus());
  });

  it('says starter prompts are loading (not unavailable) while the context loads', async () => {
    stubServer({ prompts: [] });
    const user = userEvent.setup();
    const { rerender } = render(<Harness spies={spies} context={null} />);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Prompt library/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    const starters = within(dialog).getByRole('region', { name: 'Starter prompts' });
    expect(starters).toHaveTextContent('Loading starter prompts…');
    expect(starters).not.toHaveTextContent('No starter prompts are available to you.');
    rerender(<Harness spies={spies} context={null} contextError="Could not load." />);
    expect(within(dialog).getByRole('region', { name: 'Starter prompts' })).toHaveTextContent('Starter prompts could not be loaded.');
  });

  it('hands focus to the values card when a prompt is chosen from Options ⋯ → Prompts', async () => {
    // Both favorites, so the Prompts submenu lists them.
    const { user, textarea } = setup(OWN.map((p) => ({ ...p, favorite: p.id !== 'book-b1' })));
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.keyboard('{ArrowDown}');
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'VPN anomalies' }));
    const card = await screen.findByTestId('prompt-params');
    const value = within(card).getByRole('textbox', { name: 'User' });
    await waitFor(() => expect(value).toHaveFocus());
    await user.keyboard('1.2.3.4');
    expect(value).toHaveValue('1.2.3.4');
    expect(textarea.value).toBe('');
    // A prompt with nothing to ask fills the field and focuses it (not ⋯).
    await user.click(within(card).getByRole('button', { name: 'Close without sending' }));
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Prompts' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Phishing review' }));
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.value).toBe('Summarise phishing cases.');
  });

  it('opens from the new-chat empty state link', async () => {
    stubServer({ prompts: OWN.map((p) => ({ ...p })) });
    const user = userEvent.setup();
    render(
      <>
        <EmptyState context={makeContext()} onStarter={vi.fn()} />
        <Harness spies={spies} context={makeContext()} />
      </>,
    );
    await user.click(screen.getByRole('button', { name: LIBRARY_LINK }));
    expect(await screen.findByRole('dialog', { name: 'Prompt library' })).toBeInTheDocument();
  });

  it('is axe-clean with the library open and with the values card open', async () => {
    const { user } = setup();
    const dialog = await openLibrary(user);
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Use Hunt an indicator' }));
    await screen.findByTestId('prompt-params');
    await act(async () => {});
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
  });
});
