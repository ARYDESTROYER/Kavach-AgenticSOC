/**
 * The Workspace composer's prompt-library listeners (Round 13, SPEC-chat §3.9, §5.2, §7.1):
 *
 * - `openPromptLibrary({categories})` (a start-screen pill) opens the library filtered to
 *   those categories; the library opened any other way is the whole library again.
 * - `pickPromptFromLibrary(id)` (a `use_prompt` starter card) runs the id through exactly
 *   the library's Use path: a prompt with nothing to ask fills the field, one with values
 *   opens its values card (focused), a saved prompt is read first, and an id that cannot
 *   be found says so in a toast and changes nothing. Nothing is ever sent by a pick.
 * - The compact Case Manager composer listens to neither.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const announce = vi.hoisted(() => vi.fn());
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { act, render, screen, waitFor, within } from '@testing-library/react';
import { PROMPT_READ_FAILED, PROMPT_UNAVAILABLE } from '../Composer';
import { openPromptLibrary, pickPromptFromLibrary } from '../library-events';
import { Harness, makeSpies, stubServer, type EngineSpies } from './harness';
import { makeContext } from './fixtures';

let spies: EngineSpies;
beforeEach(() => {
  spies = makeSpies();
  toast.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const textarea = () => screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;

/** The starter prompt titles the open library lists. */
function starterTitles(): string[] {
  const dialog = screen.getByRole('dialog', { name: 'Prompt library' });
  const region = within(dialog).queryByRole('region', { name: 'Starter prompts' });
  if (!region) return [];
  return within(region)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-row-title]')?.textContent ?? '');
}

describe('openPromptLibrary', () => {
  it('opens the library filtered to the pill\'s categories, and the whole library otherwise', async () => {
    stubServer();
    render(<Harness spies={spies} context={makeContext()} />);
    act(() => openPromptLibrary({ categories: ['hunt', 'ioc'] }));
    await screen.findByRole('dialog', { name: 'Prompt library' });
    const filtered = starterTitles();
    expect(filtered).toContain('Hunt an indicator');
    expect(filtered).toContain('Indicator reputation');
    expect(filtered).not.toContain('Shift handoff');
    // Closed, then opened from the `/` menu's library entry: no filter carried over.
    act(() => screen.getByRole('dialog', { name: 'Prompt library' }).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompt library' })).toBeNull());
    act(() => openPromptLibrary());
    await screen.findByRole('dialog', { name: 'Prompt library' });
    expect(starterTitles()).toContain('Shift handoff');
    expect(starterTitles()).toContain('Hunt an indicator');
  });

  it('hands focus back to the pill that opened it when closed without a choice, and forward after Use', async () => {
    stubServer();
    render(<Harness spies={spies} context={makeContext()} />);
    // "Outside" stands in for a start-screen category pill (outside the composer).
    const pill = screen.getByRole('button', { name: 'Outside' });
    act(() => pill.focus());
    act(() => openPromptLibrary({ categories: ['hunt'] }));
    const dialog = await screen.findByRole('dialog', { name: 'Prompt library' });
    act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompt library' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pill));
    // Opened from the pill again, and a prompt used: focus goes to the field it filled.
    act(() => openPromptLibrary({ categories: ['reporting'] }));
    const again = await screen.findByRole('dialog', { name: 'Prompt library' });
    const region = within(again).getByRole('region', { name: 'Starter prompts' });
    const row = within(region)
      .getAllByRole('listitem')
      .find((li) => li.querySelector('[data-row-title]')?.textContent === 'Shift handoff')!;
    act(() => (row.querySelector('button') as HTMLButtonElement).click());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompt library' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(textarea()));
    expect(textarea().value).toMatch(/^Write a shift brief/);
  });

  it('is ignored by the Case Manager composer', async () => {
    stubServer();
    render(<Harness spies={spies} context={makeContext()} variant="case" />);
    act(() => openPromptLibrary({ categories: ['triage'] }));
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'Prompt library' })).toBeNull();
  });
});

describe('pickPromptFromLibrary', () => {
  it('fills the field with a ready-made prompt that asks for nothing, and sends nothing', async () => {
    stubServer();
    render(<Harness spies={spies} context={makeContext()} />);
    act(() => pickPromptFromLibrary('starter:shift-handoff'));
    await waitFor(() =>
      expect(textarea().value).toBe('Write a shift brief for the handoff: a summary, open work, key metrics and next steps.'),
    );
    expect(document.activeElement).toBe(textarea());
    expect(spies.send).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('opens the values card of a prompt with values and focuses it', async () => {
    stubServer();
    render(<Harness spies={spies} context={makeContext()} />);
    act(() => pickPromptFromLibrary('starter:hunt-indicator'));
    const card = await screen.findByTestId('prompt-params');
    await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
    expect(textarea().value).toBe('');
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('reads the saved prompts first, then uses the analyst\'s own prompt', async () => {
    const server = stubServer({ prompts: [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' }] });
    render(<Harness spies={spies} context={makeContext()} />);
    act(() => pickPromptFromLibrary('p1'));
    await waitFor(() => expect(textarea().value).toBe('Any odd VPN logins this week?'));
    expect(server.calls.some((call) => call.url === '/api/prefs/user' && call.method === 'GET')).toBe(true);
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('checks the server again before calling a prompt gone (saved in another tab)', async () => {
    const server = stubServer({ prompts: [] });
    render(<Harness spies={spies} context={makeContext()} />);
    const reads = () => server.calls.filter((call) => call.url === '/api/prefs/user' && call.method === 'GET').length;
    // The composer reads its (empty) list once, on the first pick.
    act(() => pickPromptFromLibrary('starter:shift-handoff'));
    await waitFor(() => expect(textarea().value).toMatch(/^Write a shift brief/));
    await waitFor(() => expect(reads()).toBe(1));
    // Saved in another tab afterwards: not in the list this composer holds.
    server.prompts = [{ id: 'p-new', title: 'New one', text: 'Which hosts talked to 10.0.0.5?' }];
    act(() => pickPromptFromLibrary('p-new'));
    await waitFor(() => expect(textarea().value).toBe('Which hosts talked to 10.0.0.5?'));
    expect(reads()).toBe(2);
    expect(toast).not.toHaveBeenCalled();
  });

  it('says a prompt that no longer exists is unavailable, and changes nothing', async () => {
    stubServer({ prompts: [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' }] });
    render(<Harness spies={spies} context={makeContext()} draft="my own words" />);
    act(() => pickPromptFromLibrary('p-gone'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(PROMPT_UNAVAILABLE));
    expect(PROMPT_UNAVAILABLE).toBe('That saved prompt is no longer available.');
    expect(textarea().value).toBe('my own words');
    expect(screen.queryByTestId('prompt-params')).toBeNull();
  });

  it('says the saved prompts could not be loaded when the read fails, never that the prompt is gone', async () => {
    // GET /api/prefs/user answers 503: 'p1' may well exist, only the read failed.
    const server = stubServer({ prompts: [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' }], getStatus: 503 });
    render(<Harness spies={spies} context={makeContext()} draft="my own words" />);
    act(() => pickPromptFromLibrary('p1'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(PROMPT_READ_FAILED));
    expect(PROMPT_READ_FAILED).toBe('Saved prompts could not be loaded. Try again.');
    expect(toast).not.toHaveBeenCalledWith(PROMPT_UNAVAILABLE);
    expect(textarea().value).toBe('my own words');
    expect(screen.queryByTestId('prompt-params')).toBeNull();
    // Both the list load and the re-read before giving up were tried.
    expect(server.calls.filter((call) => call.url === '/api/prefs/user' && call.method === 'GET').length).toBe(2);
    // The server recovers: the next pick of the same prompt uses it.
    server.getStatus = 200;
    toast.error.mockClear();
    act(() => pickPromptFromLibrary('p1'));
    await waitFor(() => expect(textarea().value).toBe('Any odd VPN logins this week?'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('never runs a ready-made prompt whose tools this viewer cannot use', async () => {
    stubServer();
    render(<Harness spies={spies} context={makeContext({}, { shift_report: 'cases:read' })} />);
    act(() => pickPromptFromLibrary('starter:shift-handoff'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(PROMPT_UNAVAILABLE));
    expect(textarea().value).toBe('');
  });

  it('drops a malformed id at the event, and the Case Manager composer ignores picks', async () => {
    stubServer({ prompts: [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' }] });
    const { unmount } = render(<Harness spies={spies} context={makeContext()} />);
    act(() => pickPromptFromLibrary('<img src=x>'));
    await act(async () => {});
    expect(textarea().value).toBe('');
    expect(toast).not.toHaveBeenCalled();
    unmount();
    render(<Harness spies={spies} context={makeContext()} variant="case" />);
    act(() => pickPromptFromLibrary('p1'));
    await act(async () => {});
    expect((screen.getByRole('textbox', { name: 'Ask about this case' }) as HTMLTextAreaElement).value).toBe('');
  });
});
