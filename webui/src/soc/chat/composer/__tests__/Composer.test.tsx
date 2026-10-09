/**
 * Composer (SPEC §10.4, §10.4a, §8): the control row, Enter/Shift+Enter/IME, Send ↔
 * Stop and the Esc rules, ↑ edit-last, the `/` and `@` menus (cmdk, focus kept in the
 * textarea), scope chips and their narrow merge, the meter and budget ring, Options
 * (live mode, model, shortcuts, saved prompts), budget/disabled blocks, the compact
 * case variant, the imperative handle, and axe in idle, running and menu-open states.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shell announcer is a no-op without its provider; a spy shows what is spoken.
const announce = vi.hoisted(() => vi.fn());
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';
import type { SourceInstance } from '@/lib/types';
import type { ComposerHandle } from '../Composer';
import {
  CASE_COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_NARROW,
  READ_ONLY_TOOLTIP,
} from '../Composer';
import { TYPE_OUT_HELPER } from '../ComposerOptions';
import { Harness, makeSpies, stubComposerWidth, stubServer, type EngineSpies, type HarnessProps } from './harness';
import { makeContext } from './fixtures';

expect.extend(toHaveNoViolations);

/** A source row as the server sends it (Demo Mode adds `demo`). */
type HarnessSource = SourceInstance & { demo?: boolean };

let spies: EngineSpies;
beforeEach(() => {
  spies = makeSpies();
  announce.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(props: Partial<HarnessProps> = {}) {
  const server = stubServer();
  const user = userEvent.setup();
  const view = render(<Harness spies={spies} context={makeContext()} {...props} />);
  const textarea = screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;
  return { server, user, view, textarea };
}

const flush = () => act(async () => {});

describe('Composer — layout and copy', () => {
  it('renders the placeholder, the Read-only chip, the scope chip and Send in one row', async () => {
    const { textarea } = setup();
    expect(textarea).toHaveAttribute('placeholder', COMPOSER_PLACEHOLDER);
    expect(screen.getByRole('button', { name: 'Read-only. What can the assistant access?' })).toHaveTextContent('Read-only');
    // Two queryable sources (the disabled one is filtered) → nothing selected = All sources.
    expect(await screen.findByRole('button', { name: /^Scope: All sources, Last 24 hours/ })).toHaveTextContent(
      'All sources · 24h',
    );
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toHaveAttribute('aria-keyshortcuts', 'Enter');
    expect(send).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the exact Read-only tooltip and opens the access popover', async () => {
    const { user } = setup({ context: makeContext({}, { cost_usage: 'cost:view' }) });
    const chip = screen.getByRole('button', { name: 'Read-only. What can the assistant access?' });
    await user.hover(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(READ_ONLY_TOOLTIP);
    await user.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'What the assistant can access' });
    // Capabilities read in the present tense, not as the run log's past tense.
    expect(within(dialog).getByText('Read AI cost and usage')).toBeInTheDocument();
    expect(within(dialog).getByText('Search logs')).toBeInTheDocument();
    expect(within(dialog).queryByText('Searched logs')).toBeNull();
    expect(within(dialog).getByText('Needs cost:view')).toBeInTheDocument();
    expect(within(dialog).getByText('10 of 11 lookups are available to you.')).toBeInTheDocument();
  });
});

describe('Composer — keyboard', () => {
  it('Enter sends the draft; Shift+Enter adds a line', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, 'first line{Shift>}{Enter}{/Shift}second');
    expect(textarea.value).toBe('first line\nsecond');
    expect(spies.send).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(spies.send).toHaveBeenCalledWith(undefined, undefined);
    expect(textarea.value).toBe('');
  });

  it('ignores Enter while an input method composes', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, 'こんにちは');
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('↑ in an empty composer brings back the last prompt, never over a draft', async () => {
    const { user, textarea } = setup({ lastUserPrompt: 'Top source IPs today?' });
    act(() => textarea.focus());
    await user.keyboard('{ArrowUp}');
    expect(textarea.value).toBe('Top source IPs today?');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    await user.clear(textarea);
    await user.type(textarea, 'draft');
    await user.keyboard('{ArrowUp}');
    expect(textarea.value).toBe('draft');
  });
});

/*
 * Ported from the pre-revamp ChatPanel suite (deleted with ChatPanel): the composer-level
 * guarantees the Workspace and Case Manager hosts rely on.
 */
describe('Composer — pre-revamp guarantees', () => {
  it('Shift+Enter never sends; plain Enter sends the exact text', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, 'keyboard question');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(spies.send).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(spies.send).toHaveBeenCalledWith(undefined, undefined);
  });

  it('keeps the composed text through an IME Enter, then sends once composition ends', async () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: '正在调查' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea, { key: 'Process', keyCode: 229 });
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('正在调查');
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: false });
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it('offers only enabled, browsable sources and labels the default scope truthfully', async () => {
    stubServer({
      sources: [
        { id: 'elastic-live', source_type: 'elasticsearch', display_name: 'Elastic live', enabled: true, can_browse: true },
        { id: 'elastic-off', source_type: 'elasticsearch', display_name: 'Elastic disabled', enabled: false, can_browse: true },
        { id: 'webhook', source_type: 'webhook', display_name: 'Webhook push', enabled: true, can_browse: false },
        { id: 'demo-entra', source_type: 'entra_id', display_name: 'Microsoft Entra ID', enabled: true, can_browse: true, demo: true },
      ] as HarnessSource[],
    });
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} />);
    await user.click(await screen.findByRole('button', { name: /^Scope: All sources/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Scope' });
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Elastic live/ })).toBeInTheDocument());
    expect(within(dialog).getByRole('radio', { name: /All sources/ })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Microsoft Entra ID/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: /Elastic disabled/ })).toBeNull();
    expect(within(dialog).queryByRole('radio', { name: /Webhook push/ })).toBeNull();
  });

  it("shows each thread's own draft and reports edits to the host (never shared between threads)", async () => {
    stubServer();
    const onDraftChange = vi.fn();
    const view = render(
      <Harness spies={spies} context={makeContext()} controlledDraft="unfinished query" onDraftChange={onDraftChange} />,
    );
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' });
    expect(textarea).toHaveValue('unfinished query');
    fireEvent.change(textarea, { target: { value: 'updated query' } });
    expect(onDraftChange).toHaveBeenLastCalledWith('updated query');
    view.rerender(
      <Harness spies={spies} context={makeContext()} controlledDraft="another thread draft" onDraftChange={onDraftChange} />,
    );
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toHaveValue('another thread draft');
    await flush();
  });
});

describe('Composer — while a turn runs', () => {
  it('swaps Send for Stop, keeps the textarea editable and makes Enter do nothing', async () => {
    const { user, textarea } = setup({ busy: true });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toHaveAttribute('aria-keyshortcuts', 'Escape');
    await user.type(textarea, 'next question');
    expect(textarea.value).toBe('next question');
    await user.keyboard('{Enter}');
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('next question');
    await user.click(stop);
    expect(spies.stop).toHaveBeenCalledTimes(1);
  });

  it('Esc in the composer stops the turn', async () => {
    const { user, textarea } = setup({ busy: true });
    act(() => textarea.focus());
    await user.keyboard('{Escape}');
    expect(spies.stop).toHaveBeenCalledTimes(1);
  });

  it('Esc with the / menu open closes the menu first and does not stop', async () => {
    const { user, textarea } = setup({ busy: true });
    await user.type(textarea, '/');
    expect(await screen.findByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Commands' })).toBeNull());
    expect(spies.stop).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(spies.stop).toHaveBeenCalledTimes(1);
  });

  it('Esc does not stop while the Options menu is open or when focus is outside', async () => {
    const { user } = setup({ busy: true });
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    // Each Esc closes the topmost layer: the trigger's tooltip (opened by the test's
    // instant hover), then the menu. Neither stops the turn.
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(spies.stop).not.toHaveBeenCalled();
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    await user.keyboard('{Escape}');
    expect(spies.stop).not.toHaveBeenCalled();
  });

  it('marks Stop unavailable for a turn that cannot be stopped', () => {
    setup({ busy: true, canStop: false });
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Composer — / commands', () => {
  it('lists only allowed commands, filters as you type and sends a fixed command with origin "command"', async () => {
    const { user, textarea } = setup({ context: makeContext({}, { cost_usage: 'cost:view' }) });
    await user.type(textarea, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands' });
    const names = within(list).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names.some((n) => n.startsWith('/cost'))).toBe(false);
    expect(names.some((n) => n.startsWith('/posture'))).toBe(true);
    // Focus never left the textarea, which points at the highlighted option.
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toHaveAttribute('aria-controls', list.id);
    const first = within(list).getAllByRole('option')[0];
    expect(textarea).toHaveAttribute('aria-activedescendant', first.id);
    await user.keyboard('{ArrowDown}');
    expect(textarea.getAttribute('aria-activedescendant')).not.toBe(first.id);

    await user.type(textarea, 'pos');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    await user.keyboard('{Enter}');
    expect(spies.send).toHaveBeenCalledWith(
      'How is our security posture right now? Show the key metrics and how they are trending.',
      { origin: 'command' },
    );
    expect(textarea.value).toBe('');
  });

  it('reopens a dismissed menu once the draft changes', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, '/');
    await screen.findByRole('listbox', { name: 'Commands' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await user.keyboard('{Backspace}');
    await user.type(textarea, '/');
    expect(await screen.findByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
  });

  it('fills an argument command and selects its placeholder instead of sending', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, '/hu');
    await screen.findByRole('listbox', { name: 'Commands' });
    await user.keyboard('{Enter}');
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Hunt for <indicator> across logs, cases and threat intel. What do we know about it?');
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('<indicator>');
    await user.keyboard('8.8.8.8');
    expect(textarea.value).toContain('Hunt for 8.8.8.8 across');
  });

  it('expands a typed argument into the composer; the next Enter sends it as user text', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, '/hunt 8.8.8.8');
    await screen.findByRole('listbox', { name: 'Commands' });
    await user.keyboard('{Enter}');
    expect(textarea.value).toBe('Hunt for 8.8.8.8 across logs, cases and threat intel. What do we know about it?');
    expect(spies.send).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(spies.send).toHaveBeenCalledWith(undefined, undefined);
  });

  it('lists saved prompts after the commands and inserts the chosen one', async () => {
    const server = stubServer({ prompts: [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' }] });
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} />);
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;
    await user.type(textarea, '/vpn');
    const option = await screen.findByRole('option', { name: /VPN anomalies/ });
    expect(server.calls.some((c) => c.url === '/api/prefs/user')).toBe(true);
    await user.click(option);
    expect(textarea.value).toBe('Any odd VPN logins this week?');
    expect(document.activeElement).toBe(textarea);
  });
});

describe('Composer — @ scopes and the scope chip', () => {
  it('adds a scope chip from the @ menu, disables denied scopes with the permission, removes chips', async () => {
    const { user, textarea } = setup({ context: makeContext({}, { search_logs: 'sources:read', log_stats: 'sources:read' }) });
    await user.type(textarea, '@');
    const list = await screen.findByRole('listbox', { name: 'Scopes' });
    const logs = within(list).getByRole('option', { name: /@logs/ });
    expect(logs).toHaveAttribute('aria-disabled', 'true');
    expect(logs).toHaveTextContent('Needs sources:read');
    await user.type(textarea, 'ca');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('scopes')).toHaveTextContent('cases');
    expect(textarea.value).toBe('');
    await user.click(screen.getByRole('button', { name: 'Remove scope Cases' }));
    expect(screen.getByTestId('scopes')).toHaveTextContent('');
    expect(document.activeElement).toBe(textarea);
  });

  it('edits source and time range in one popover', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: /^Scope: All sources/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Scope' });
    await user.click(within(dialog).getByRole('radio', { name: /Elastic prod/ }));
    expect(spies.setSourceId).toHaveBeenLastCalledWith('e');
    expect(within(dialog).getByText('Last 24 hours, unless your question names another window.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: '7d' }));
    expect(spies.setTimeRange).toHaveBeenLastCalledWith({ from: 'now-7d' });
    // A chosen range is an outer bound: a question can narrow it, never widen it.
    expect(within(dialog).getByText('Last 7 days. Questions can narrow this range, not widen it.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/unless your question names another window/)).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: '24h' }));
    expect(spies.setTimeRange).toHaveBeenLastCalledWith(null);
    expect(within(dialog).getByText('Last 24 hours, unless your question names another window.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Metrics' }));
    expect(screen.getByTestId('scopes')).toHaveTextContent('metrics');
    expect(screen.getByRole('button', { name: /^Scope: Elastic prod/ })).toHaveTextContent('Elastic prod · 24h');
  });

  it('reads a custom absolute range and an explicit now-24h as outer bounds a question can only narrow', async () => {
    const custom = setup({ timeRange: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' } });
    await custom.user.click(await screen.findByRole('button', { name: /^Scope: All sources/ }));
    let dialog = await screen.findByRole('dialog', { name: 'Scope' });
    expect(
      within(dialog).getByText(
        'From 2026-10-01T00:00:00Z to 2026-10-02T00:00:00Z. Questions can narrow this range, not widen it.',
      ),
    ).toBeInTheDocument();
    // No preset matches, so no time segment is selected.
    for (const id of ['1h', '24h', '7d', '30d', '90d']) {
      expect(within(dialog).getByRole('radio', { name: id })).not.toBeChecked();
    }
    custom.view.unmount();

    // An explicit range equal to the default is still a chosen range, so it clamps.
    const explicit = setup({ timeRange: { from: 'now-24h' } });
    await explicit.user.click(await screen.findByRole('button', { name: /^Scope: All sources/ }));
    dialog = await screen.findByRole('dialog', { name: 'Scope' });
    expect(within(dialog).getByText('Last 24 hours. Questions can narrow this range, not widen it.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/unless your question names another window/)).toBeNull();
  });

  it('says why a source cannot be chosen without sources:read', async () => {
    stubServer({ sourcesStatus: 403 });
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} />);
    await user.click(await screen.findByRole('button', { name: /^Scope:/ }));
    expect(await screen.findByText(/Choosing a source needs sources:read/)).toBeInTheDocument();
  });

  it('merges Scope and @ chips into "Scope · n" below 560 px', async () => {
    stubComposerWidth(420);
    setup({ scopes: ['cases', 'logs'] });
    const merged = await screen.findByRole('button', { name: /^Scope: 2 set/ });
    expect(merged).toHaveTextContent('Scope · 2');
    expect(screen.queryByRole('button', { name: 'Remove scope Cases' })).toBeNull();
    // The lock keeps its accessible name with the icon only.
    expect(screen.getByRole('button', { name: 'Read-only. What can the assistant access?' })).not.toHaveTextContent(
      'Read-only',
    );
  });
});

describe('Composer — meter', () => {
  it('estimates the next request from system + history + draft', async () => {
    const { user, textarea } = setup();
    // 1,000 static + 200 history + 400 chars ÷ 4 = 1,300.
    await user.click(textarea);
    await user.paste('x'.repeat(400));
    const estimate = screen.getByRole('button', { name: 'Estimated next request: ≈ 1.3k tokens' });
    expect(estimate).toHaveTextContent('≈ 1.3k');
    await user.click(estimate);
    expect(await screen.findByText('Next request')).toBeInTheDocument();
    expect(screen.getByText('≈ 1,300')).toBeInTheDocument();
    expect(screen.getByText('History · last 12 exchanges')).toBeInTheDocument();
    expect(screen.getByText('Whole question')).toBeInTheDocument();
    expect(screen.getByText('Per-question limit')).toBeInTheDocument();
    expect(screen.queryByText(/Projected cost/)).toBeNull();
    expect(screen.queryByText(/Today's AI spend/)).toBeNull();
  });

  it('shows money only when the context carries it, and the ring as a real meter', async () => {
    const context = makeContext({
      rates: { input_per_million: 3, output_per_million: 15 },
      budget: { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' },
      spent_today: 4.2,
      simulated: false,
    });
    const { user } = setup({ context, conversationTotals: { tokens: 12_400, cost: 0.03 } });
    const meter = screen.getByRole('meter', { name: "Today's AI budget" });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).toHaveAttribute('aria-valuetext', "42% of today's AI budget used, $4.20 of $10.00.");
    expect(meter).toHaveTextContent('42%');
    await user.click(screen.getByRole('button', { name: /Estimated next request/ }));
    expect(await screen.findByText('Projected cost')).toBeInTheDocument();
    expect(screen.getByText("Today's AI spend")).toBeInTheDocument();
    expect(screen.getByText('$4.20 of $10.00')).toBeInTheDocument();
    // The same grammar as the thread toolbar and the run log.
    expect(screen.getByText('12.4k tokens · $0.03')).toBeInTheDocument();
    expect(screen.getByText(/Chat shares this budget with automatic investigations/)).toBeInTheDocument();
  });

  it('counts a case chat\'s own history (the context cannot see it, SPEC §4.3)', async () => {
    // /chat/context reports 0 history for a case scope; the engine holds 2 exchanges
    // of 8,000 chars: 1,000 static + 2,000 history + 0 draft = 3,000.
    const context = makeContext({ history_tokens: 0, history_exchanges: 0 });
    stubServer();
    render(
      <Harness spies={spies} context={context} variant="case" persist={false} historySize={{ exchanges: 2, chars: 8_000 }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Estimated next request: ≈ 3k tokens' }));
    expect(await screen.findByText('History · last 2 exchanges')).toBeInTheDocument();
    expect(screen.getByText('2,000')).toBeInTheDocument();
  });

  it('hides the ring without a budget and the whole meter until the context loads', () => {
    setup();
    expect(screen.queryByRole('meter')).toBeNull();
    render(<Harness spies={spies} context={null} />);
    expect(screen.getAllByRole('button', { name: /Estimated next request/ })).toHaveLength(1);
  });
});

describe('Composer — Options', () => {
  it('toggles Type out answers with the exact helper copy', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    // Named by its title only; the helper is the description (spoken once).
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Type out answers' });
    expect(item).toHaveAccessibleDescription(TYPE_OUT_HELPER);
    expect(item).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveTextContent(TYPE_OUT_HELPER);
    await user.click(item);
    expect(spies.setStreamMode).toHaveBeenCalledWith('text');
    // The menu stays open so the new state is visible.
    expect(screen.getByRole('menuitemcheckbox', { name: /Type out answers/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('disables Type out answers with the reason when text streaming is unavailable', async () => {
    const context = makeContext({ text_streaming: { available: false, reason: 'disabled_by_admin' } });
    const { user } = setup({ context, streamMode: 'text' });
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    const item = await screen.findByRole('menuitemcheckbox', { name: /Type out answers/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveTextContent('Turned off by your administrator.');
    expect(item).toHaveAccessibleName('Type out answers');
    expect(item).toHaveAccessibleDescription(`${TYPE_OUT_HELPER} Turned off by your administrator.`);
  });

  it('opens the keyboard shortcuts', async () => {
    const onOpenShortcuts = vi.fn();
    const { user } = setup({ onOpenShortcuts });
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    const item = await screen.findByRole('menuitem', { name: /Keyboard shortcuts/ });
    expect(item).toHaveAttribute('aria-keyshortcuts', 'Control+/ Meta+/');
    await user.click(item);
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1);
  });

  it('picks a model when allowed and shows it as a removable chip', async () => {
    const { user } = setup({ canChooseModel: true });
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Model/ }));
    // Radix sub-menus close on a pointer path outside their (unlaid-out) grace area in
    // jsdom, so the item is activated directly.
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /gpt-x/ }));
    expect(spies.setModel).toHaveBeenCalledWith('gpt-x');
    const remove = await screen.findByRole('button', { name: 'Use the default model instead of gpt-x' });
    await user.click(remove);
    expect(spies.setModel).toHaveBeenLastCalledWith(null);
  });

  it('shows the model read-only without models:read', async () => {
    const { user } = setup({ canChooseModel: false });
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: /Model/ })).toBeNull();
    expect(screen.getByText('claude-sonnet-test')).toBeInTheDocument();
  });

  it('saves the current prompt through the prefs routes', async () => {
    const server = stubServer();
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} draft={'Weekly phishing review\nSummarise phishing.'} />);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Saved prompts/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Save current prompt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save prompt' });
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('Weekly phishing review');
    await user.click(within(dialog).getByRole('button', { name: 'Save prompt' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save prompt' })).toBeNull());
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({
      chat_prompts: [{ title: 'Weekly phishing review', text: 'Weekly phishing review\nSummarise phishing.' }],
    });
  });
});

describe('Composer — blocked sending', () => {
  it('keeps Send when the budget is reached and set to block (Help Center answers still run)', async () => {
    const context = makeContext({
      budget_state: 'reached',
      budget: { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' },
    });
    const { user, textarea } = setup({ context, draft: 'How do I add a source?' });
    expect(textarea).not.toHaveAttribute('placeholder', expect.stringMatching(/budget/i));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).not.toHaveAttribute('aria-disabled');
    expect(send).not.toHaveAccessibleDescription(expect.stringMatching(/budget/i));
    act(() => textarea.focus());
    await user.keyboard('{Enter}');
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it('keeps Send when the budget only warns', () => {
    const context = makeContext({
      budget_state: 'reached',
      budget: { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'warn' },
    });
    setup({ context, draft: 'hello' });
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled');
  });

  it('shows the host reason and refuses to send', async () => {
    const { user, textarea } = setup({ disabledReason: 'Restoring this conversation…', draft: 'hello' });
    expect(textarea).toHaveAttribute('placeholder', 'Restoring this conversation…');
    act(() => textarea.focus());
    await user.keyboard('{Enter}');
    expect(spies.send).not.toHaveBeenCalled();
  });
});

describe('Composer — case variant', () => {
  it('is the textarea, estimate, Options (Model, Type out answers) and Send', async () => {
    stubServer();
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} variant="case" canChooseModel />);
    const textarea = screen.getByRole('textbox', { name: 'Ask about this case' });
    // No / or @ menus here, so the placeholder never advertises them.
    expect(textarea).toHaveAttribute('placeholder', CASE_COMPOSER_PLACEHOLDER);
    expect(textarea.getAttribute('placeholder')).not.toMatch(/[/@]/);
    expect(screen.queryByRole('button', { name: /Read-only/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Scope/ })).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByRole('button', { name: /Estimated next request/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await screen.findByRole('menu');
    expect(screen.getByRole('menuitem', { name: /Model/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: /Type out answers/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Saved prompts/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeNull();
  });

  it('does not open the / menu', async () => {
    stubServer();
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} variant="case" />);
    await user.type(screen.getByRole('textbox', { name: 'Ask about this case' }), '/');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-autocomplete');
  });

  it('asks for /chat/context freshness on focus and never reads the source list', async () => {
    const server = stubServer();
    const onComposerFocus = vi.fn();
    render(<Harness spies={spies} context={makeContext()} variant="case" onComposerFocus={onComposerFocus} />);
    act(() => screen.getByRole('textbox', { name: 'Ask about this case' }).focus());
    expect(onComposerFocus).toHaveBeenCalledTimes(1);
    await flush();
    expect(server.calls.some((c) => c.url === '/api/sources')).toBe(false);
  });
});

describe('Composer — handle', () => {
  it('focuses, replaces the text and opens Save prompt', async () => {
    stubServer();
    const ref = React.createRef<ComposerHandle>();
    render(<Harness spies={spies} context={makeContext()} handleRef={ref} />);
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;
    act(() => ref.current?.focus());
    expect(document.activeElement).toBe(textarea);
    act(() => ref.current?.setText('edited prompt'));
    expect(textarea.value).toBe('edited prompt');
    act(() => ref.current?.savePrompt('A past question'));
    const dialog = await screen.findByRole('dialog', { name: 'Save prompt' });
    expect(within(dialog).getByRole('textbox', { name: 'Prompt' })).toHaveValue('A past question');
  });
});

describe('Composer — Tab in the menus', () => {
  it('"/" then Tab never sends a command turn, and focus moves on', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands' });
    // The highlighted first command sends at once with Enter (/shift-brief)...
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('/shift-brief');
    // ...but Tab is focus navigation: no paid turn, the draft is untouched.
    await user.tab();
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('/');
    expect(document.activeElement).not.toBe(textarea);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('"@" then Tab adds no scope and is not swallowed', async () => {
    const { user, textarea } = setup();
    await user.type(textarea, '@');
    await screen.findByRole('listbox', { name: 'Scopes' });
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(textarea, { key: 'Tab' })).toBe(true);
    expect(screen.getByTestId('scopes')).toHaveTextContent('');
    expect(textarea.value).toBe('@');
  });
});

describe('Composer — narrow composer', () => {
  it('uses the one-line placeholder and keeps an icon-only model chip', async () => {
    stubComposerWidth(420);
    const { textarea } = setup({ model: 'gpt-x' });
    await waitFor(() => expect(textarea).toHaveAttribute('placeholder', COMPOSER_PLACEHOLDER_NARROW));
    expect(COMPOSER_PLACEHOLDER_NARROW.length).toBeLessThan(40);
    const remove = screen.getByRole('button', { name: 'Use the default model instead of gpt-x' });
    const chip = remove.closest('[data-model-chip="compact"]') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip).toHaveAttribute('title', 'Model: gpt-x');
    expect(within(chip).getByText('Model: gpt-x')).toHaveClass('sr-only');
    const user = userEvent.setup();
    await user.click(remove);
    expect(spies.setModel).toHaveBeenLastCalledWith(null);
  });

  it('keeps the full placeholder at roomy widths', () => {
    stubComposerWidth(720);
    const { textarea } = setup();
    expect(textarea).toHaveAttribute('placeholder', COMPOSER_PLACEHOLDER);
  });
});

describe('Composer — context not loaded or unreadable', () => {
  it('keeps the @ menu closed until the catalogue loads (never lists every scope as denied)', async () => {
    const { user, textarea } = setup({ context: null });
    await user.type(textarea, '@');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea.value).toBe('@');
  });

  it('says the access list could not be loaded, with Retry, instead of checking forever', async () => {
    const onRetryContext = vi.fn();
    const { user } = setup({ context: null, contextError: 'HTTP 503', onRetryContext });
    await user.click(screen.getByRole('button', { name: 'Read-only. What can the assistant access?' }));
    const dialog = await screen.findByRole('dialog', { name: 'What the assistant can access' });
    expect(within(dialog).getByText("Couldn't load what the assistant can access.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Checking what you can access/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(onRetryContext).toHaveBeenCalledTimes(1);
  });

  it('waits for the context before reading sources, then reads them once', async () => {
    const server = stubServer();
    const view = render(<Harness spies={spies} context={null} />);
    await flush();
    expect(server.calls.some((c) => c.url === '/api/sources')).toBe(false);
    view.rerender(<Harness spies={spies} context={makeContext()} />);
    await screen.findByRole('button', { name: /^Scope: All sources/ });
    expect(server.calls.filter((c) => c.url === '/api/sources')).toHaveLength(1);
  });

  it('never asks for the source list without sources:read (no 403, no audit row)', async () => {
    const deny = { search_logs: 'sources:read', log_stats: 'sources:read', source_health: 'sources:read' };
    const { user, server } = setup({ context: makeContext({}, deny) });
    await user.click(await screen.findByRole('button', { name: /^Scope:/ }));
    expect(await screen.findByText(/Choosing a source needs sources:read/)).toBeInTheDocument();
    expect(server.calls.some((c) => c.url === '/api/sources')).toBe(false);
  });
});

describe('Composer — blocked Enter', () => {
  // Only the host blocks Send (a spent budget never does, SPEC §10.3).
  const reason = 'Restoring this conversation…';

  it('describes the field with the reason and speaks it when Enter is refused', async () => {
    const { user, textarea } = setup({ disabledReason: reason, draft: 'hello' });
    expect(textarea).toHaveAccessibleDescription(/Restoring this conversation…$/);
    act(() => textarea.focus());
    await user.keyboard('{Enter}');
    expect(spies.send).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith(reason);
  });

  it('stays quiet on an empty draft or while a turn runs', async () => {
    const { user, textarea } = setup({ disabledReason: reason });
    act(() => textarea.focus());
    await user.keyboard('{Enter}');
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('Composer — chat models', () => {
  it('offers only models the server declares chat for', async () => {
    stubServer({
      models: {
        providers: { openai: ['gpt-x', 'text-embedding-3-small'], anthropic: ['claude-sonnet-test'] },
        configured: {},
        capabilities: { 'gpt-x': ['chat'], 'text-embedding-3-small': ['embedding'], 'claude-sonnet-test': ['chat'] },
      },
    });
    const user = userEvent.setup();
    render(<Harness spies={spies} context={makeContext()} canChooseModel />);
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Model/ }));
    expect(await screen.findByRole('menuitemradio', { name: /gpt-x/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /text-embedding/ })).toBeNull();
  });
});

describe('Composer — managing saved prompts', () => {
  const PROMPTS = [
    { id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' },
    { id: 'p2', title: 'Phishing review', text: 'Summarise phishing cases.' },
  ];

  async function openManage(putStatus = 200) {
    const server = stubServer({ prompts: PROMPTS.map((p) => ({ ...p })), putStatus });
    const user = userEvent.setup();
    const view = render(<Harness spies={spies} context={makeContext()} />);
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;
    await user.click(screen.getByRole('button', { name: 'Composer options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Saved prompts/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Manage saved prompts/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Saved prompts' });
    await within(dialog).findByText('VPN anomalies');
    return { server, user, view, textarea, dialog };
  }

  it('uses a prompt: fills the composer, closes and returns focus there', async () => {
    const { user, textarea, dialog } = await openManage();
    expect(within(dialog).getByText('2 of 50 saved. Use one to put it in the composer.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Use VPN anomalies' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Saved prompts' })).toBeNull());
    expect(textarea.value).toBe('Any odd VPN logins this week?');
    await waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(spies.send).not.toHaveBeenCalled();
  });

  it('asks before deleting: Keep cancels, Delete removes through the prefs route', async () => {
    const { user, server, dialog } = await openManage();
    await user.click(within(dialog).getByRole('button', { name: 'Delete Phishing review…' }));
    await user.click(within(dialog).getByRole('button', { name: 'Keep Phishing review' }));
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete Phishing review…' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete Phishing review' }));
    await waitFor(() => expect(within(dialog).queryByText('Phishing review')).toBeNull());
    const put = server.calls.find((c) => c.method === 'PUT');
    expect((put?.body as { chat_prompts: { id: string }[] }).chat_prompts.map((p) => p.id)).toEqual(['p1']);
    expect(announce).toHaveBeenCalledWith('Deleted Phishing review');
  });

  it('keeps the prompt and says so when the server refuses the delete', async () => {
    const { user, dialog } = await openManage(503);
    await user.click(within(dialog).getByRole('button', { name: 'Delete VPN anomalies…' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete VPN anomalies' }));
    expect(await within(dialog).findByText(/unavailable|could not be deleted/i)).toBeInTheDocument();
    expect(within(dialog).getByText('VPN anomalies')).toBeInTheDocument();
    expect(announce).not.toHaveBeenCalledWith('Deleted VPN anomalies');
  });

  it('is axe-clean', async () => {
    await openManage();
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
  });
});

describe('Composer — accessibility', () => {
  it('has no axe violations idle, running and with the / menu open', async () => {
    const { user, textarea, view } = setup({ context: makeContext({ budget: { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' }, spent_today: 2 }) });
    await screen.findByRole('button', { name: /^Scope:/ });
    expect(await axe(view.container)).toHaveNoViolations();

    view.rerender(<Harness spies={spies} context={makeContext()} busy />);
    await flush();
    expect(await axe(view.container)).toHaveNoViolations();

    view.rerender(<Harness spies={spies} context={makeContext()} />);
    await user.type(textarea, '/');
    await screen.findByRole('listbox', { name: 'Commands' });
    // The menu is portaled to <body>; landmarks belong to the page shell, not here.
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
  });

  const bodyAxe = () => axe(document.body, { rules: { region: { enabled: false } } });

  it('has no axe violations with the @ menu open', async () => {
    const { user, textarea } = setup({ context: makeContext({}, { search_logs: 'sources:read', log_stats: 'sources:read' }) });
    await user.type(textarea, '@');
    await screen.findByRole('listbox', { name: 'Scopes' });
    expect(await bodyAxe()).toHaveNoViolations();
  });

  it('has no axe violations with the Scope popover open', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: /^Scope: All sources/ }));
    await screen.findByRole('dialog', { name: 'Scope' });
    expect(await bodyAxe()).toHaveNoViolations();
  });

  it('has no axe violations with the Save prompt dialog open', async () => {
    stubServer();
    const ref = React.createRef<ComposerHandle>();
    render(<Harness spies={spies} context={makeContext()} handleRef={ref} />);
    act(() => ref.current?.savePrompt('A past question'));
    await screen.findByRole('dialog', { name: 'Save prompt' });
    expect(await bodyAxe()).toHaveNoViolations();
  });

  it('has no axe violations with the meter card open', async () => {
    const context = makeContext({
      rates: { input_per_million: 3, output_per_million: 15 },
      budget: { enabled: true, daily_limit: 10, soft_warn_pct: 0.8, on_exceed: 'block' },
      spent_today: 4.2,
      calibration: 1.5,
    });
    const { user } = setup({ context, conversationTotals: { tokens: 12_400, cost: 0.03 } });
    await user.click(screen.getByRole('button', { name: /Estimated next request/ }));
    await screen.findByRole('dialog', { name: 'Token estimate' });
    expect(await bodyAxe()).toHaveNoViolations();
  });
});
