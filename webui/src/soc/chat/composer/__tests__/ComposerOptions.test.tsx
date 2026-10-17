/**
 * Options ⋯ (Round 13, SPEC-chat T25): the one-line "Type out answers" helper; the two
 * personal suggestion checkboxes, which write `UserPrefs.misc.chat_suggest_start` and
 * `chat_suggest_follow_ups` as booleans through the prefs provider (absent means on) and
 * keep the menu open; and the Options tooltip, which never opens over an open menu or
 * popover, nor on the focus a closing menu hands back to ⋯.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const prefs = vi.hoisted(() => ({
  current: null as null | { prefs: { misc: Record<string, unknown> }; patchMisc: ReturnType<typeof vi.fn> },
}));
vi.mock('@/soc/prefs', () => ({ useOptionalPrefs: () => prefs.current }));

import { TooltipProvider } from '@/ui/tooltip';
import {
  ComposerOptions,
  INLINE_SUBMENUS_QUERY,
  SUGGESTION_SWITCHES,
  TYPE_OUT_HELPER,
  suggestionOn,
  type ComposerOptionsProps,
} from '../ComposerOptions';
import { makeContext } from './fixtures';

function renderOptions(props: Partial<ComposerOptionsProps> = {}, setup: Parameters<typeof userEvent.setup>[0] = {}) {
  const user = userEvent.setup(setup);
  render(
    <TooltipProvider delayDuration={0}>
      <ComposerOptions
        variant="workspace"
        context={makeContext()}
        model={null}
        setModel={vi.fn()}
        streamMode="steps"
        setStreamMode={vi.fn()}
        canChooseModel={false}
        models={[]}
        modelsState="idle"
        loadModels={vi.fn()}
        {...props}
      />
      <button type="button">Elsewhere</button>
    </TooltipProvider>,
  );
  return { user, trigger: screen.getByRole('button', { name: 'Composer options' }) };
}

function withPrefs(misc: Record<string, unknown> = {}) {
  const patchMisc = vi.fn((patch: Record<string, unknown>) => {
    if (prefs.current) prefs.current.prefs.misc = { ...prefs.current.prefs.misc, ...patch };
  });
  prefs.current = { prefs: { misc }, patchMisc };
  return patchMisc;
}

describe('Options ⋯ — Type out answers', () => {
  it('describes the switch in one line', async () => {
    prefs.current = null;
    const { user, trigger } = renderOptions();
    expect(TYPE_OUT_HELPER).toBe('Shows the answer as it is written.');
    await user.click(trigger);
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Type out answers' });
    expect(item).toHaveAccessibleDescription(TYPE_OUT_HELPER);
  });
});

describe('Options ⋯ — suggestion switches', () => {
  it('shows both switches on by default and writes booleans through the prefs provider', async () => {
    const patchMisc = withPrefs();
    const { user, trigger } = renderOptions();
    await user.click(trigger);
    const start = await screen.findByRole('menuitemcheckbox', { name: 'Suggestions when a chat starts' });
    const followUps = screen.getByRole('menuitemcheckbox', { name: 'Suggested follow-ups' });
    expect(start).toHaveAttribute('aria-checked', 'true');
    expect(followUps).toHaveAttribute('aria-checked', 'true');
    await user.click(start);
    expect(patchMisc).toHaveBeenLastCalledWith({ chat_suggest_start: false });
    // A setting, not an action: the menu stays open.
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(followUps);
    expect(patchMisc).toHaveBeenLastCalledWith({ chat_suggest_follow_ups: false });
    for (const [patch] of patchMisc.mock.calls) {
      for (const value of Object.values(patch as Record<string, unknown>)) expect(typeof value).toBe('boolean');
    }
  });

  it('reads a stored false as off and turns it back on with true', async () => {
    const patchMisc = withPrefs({ chat_suggest_start: false, chat_suggest_follow_ups: true });
    const { user, trigger } = renderOptions();
    await user.click(trigger);
    const start = await screen.findByRole('menuitemcheckbox', { name: 'Suggestions when a chat starts' });
    expect(start).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Suggested follow-ups' })).toHaveAttribute('aria-checked', 'true');
    await user.click(start);
    expect(patchMisc).toHaveBeenLastCalledWith({ chat_suggest_start: true });
  });

  it('treats only an exact false as off', () => {
    expect(SUGGESTION_SWITCHES.map((s) => s.key)).toEqual(['chat_suggest_start', 'chat_suggest_follow_ups']);
    expect(suggestionOn(undefined, 'chat_suggest_start')).toBe(true);
    expect(suggestionOn({}, 'chat_suggest_start')).toBe(true);
    expect(suggestionOn({ chat_suggest_start: 'no' }, 'chat_suggest_start')).toBe(true);
    expect(suggestionOn({ chat_suggest_start: false }, 'chat_suggest_start')).toBe(false);
  });

  it('leaves the switches out without a prefs provider', async () => {
    prefs.current = null;
    const first = renderOptions();
    await first.user.click(first.trigger);
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Suggested follow-ups' })).toBeNull();
  });

  it('leaves the switches out of the Case Manager composer', async () => {
    withPrefs();
    const { user, trigger } = renderOptions({ variant: 'case' });
    await user.click(trigger);
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Suggestions when a chat starts' })).toBeNull();
  });
});

describe('Options ⋯ — tooltip (C11)', () => {
  it('shows "Options" on hover, never over the open menu, and not when Esc hands focus back', async () => {
    prefs.current = null;
    const { user, trigger } = renderOptions();
    await user.hover(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Options');
    await user.click(trigger);
    await screen.findByRole('menu');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await act(async () => {});
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Once focus leaves ⋯ the tooltip works again.
    await user.unhover(trigger);
    await user.tab();
    await user.hover(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Options');
  });

  it('shows "Options" again on the next hover after the menu closed on an outside click', async () => {
    prefs.current = null;
    // The modal menu blocks pointer events outside it; the outside click is the point.
    const { user, trigger } = renderOptions({}, { pointerEventsCheck: 0 });
    await user.click(trigger);
    await screen.findByRole('menu');
    // Click elsewhere: the menu closes and hands focus back to ⋯ (no tooltip for that).
    await user.click(screen.getByRole('button', { name: 'Elsewhere', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await act(async () => {});
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A fresh hover over ⋯ is a deliberate request: the tooltip shows.
    await user.hover(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Options');
  });

  it('keeps "Options" hidden when the browser re-sends pointerenter to ⋯ right after an Esc close', async () => {
    prefs.current = null;
    const { user, trigger } = renderOptions();
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    // Esc closes the menu; the page gets its pointer events back and the browser sends ⋯
    // a fresh pointerenter (no movement) before the menu hands focus back to ⋯.
    act(() => {
      fireEvent.keyDown(menu, { key: 'Escape' });
      dispatchMouse('pointerover', trigger, 0, 0);
    });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => {});
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays closed while another composer popover (the meter card) is open', async () => {
    prefs.current = null;
    const { user, trigger } = renderOptions();
    const card = document.createElement('div');
    card.setAttribute('role', 'dialog');
    card.setAttribute('data-state', 'open');
    document.body.appendChild(card);
    try {
      await user.hover(trigger);
      await act(async () => {});
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      card.remove();
    }
  });
});

/** Dispatch a mouse pointer event at a client position (jsdom has no PointerEvent). */
function dispatchMouse(type: string, target: EventTarget, x: number, y: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    relatedTarget: type === 'pointerout' ? document.body : null,
  });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  target.dispatchEvent(event);
}

/** {@link dispatchMouse} inside `act`. */
function mouse(type: string, target: EventTarget, x: number, y: number) {
  act(() => dispatchMouse(type, target, x, y));
}

describe('Options ⋯ — the tooltip hold follows where the mouse was when the menu closed (T25)', () => {
  /** ⋯ laid out at 100,100 to 132,132 (jsdom has no layout). */
  function placeTrigger(trigger: HTMLElement) {
    trigger.getBoundingClientRect = () =>
      ({ left: 100, top: 100, right: 132, bottom: 132, width: 32, height: 32, x: 100, y: 100, toJSON: () => ({}) }) as DOMRect;
  }
  /** The outside-click listener of an open Radix layer is attached on the next tick. */
  const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

  async function openWithMouseOn(trigger: HTMLElement) {
    mouse('pointerover', trigger, 110, 110);
    mouse('pointermove', trigger, 110, 110);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Options');
    mouse('pointerdown', trigger, 110, 110);
    await screen.findByRole('menu');
    expect(screen.queryByRole('tooltip')).toBeNull();
    // The open menu makes the page ignore the pointer: the browser sends ⋯ a
    // pointerleave without the mouse moving (and a pointerenter when the menu closes).
    mouse('pointerout', trigger, 110, 110);
    await tick();
  }

  it('Esc with the mouse resting on ⋯: no tooltip from the re-sent pointerenter or a jiggle, until a real leave', async () => {
    prefs.current = null;
    const { user, trigger } = renderOptions();
    placeTrigger(trigger);
    await openWithMouseOn(trigger);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    mouse('pointerover', trigger, 110, 110);
    mouse('pointermove', trigger, 111, 110);
    await act(async () => {});
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A real leave and a return is a new hover.
    mouse('pointerout', trigger, 20, 20);
    mouse('pointerover', trigger, 110, 110);
    mouse('pointermove', trigger, 110, 110);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Options');
  });

  it('a second click on ⋯ closes the menu without the tooltip popping up under the resting mouse', async () => {
    prefs.current = null;
    const { trigger } = renderOptions();
    placeTrigger(trigger);
    await openWithMouseOn(trigger);
    mouse('pointerdown', trigger, 110, 110);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    mouse('pointerover', trigger, 110, 110);
    mouse('pointermove', trigger, 110, 110);
    await act(async () => {});
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('an outside click holds only the focus hand-back: the next hover over ⋯ shows "Options"', async () => {
    prefs.current = null;
    const { trigger } = renderOptions();
    placeTrigger(trigger);
    await openWithMouseOn(trigger);
    // The mouse moves away (the page ignores it while the menu is open) and clicks there.
    mouse('pointermove', document.body, 10, 10);
    mouse('pointerdown', document.body, 10, 10);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await act(async () => {});
    expect(screen.queryByRole('tooltip')).toBeNull();
    mouse('pointerover', trigger, 110, 110);
    mouse('pointermove', trigger, 110, 110);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Options');
  });
});

describe('Options ⋯ on a phone-width screen (no room for a submenu beside the menu)', () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });
  function phoneWidth(matches: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: query === INLINE_SUBMENUS_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  const savedPrompts = {
    prompts: [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?', favorite: true }],
    state: 'ready' as const,
    error: null,
    load: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    saving: false,
    clearError: vi.fn(),
  };

  it('lists Model and Prompts inline, with no submenu to push past the screen edge', async () => {
    prefs.current = null;
    phoneWidth(true);
    const setModel = vi.fn();
    const onUsePrompt = vi.fn();
    const { user, trigger } = renderOptions({
      canChooseModel: true,
      models: [{ value: 'gpt-x', provider: 'openai' }],
      modelsState: 'ready',
      setModel,
      prompts: savedPrompts as unknown as ComposerOptionsProps['prompts'],
      onUsePrompt,
      onOpenLibrary: vi.fn(),
    });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAttribute('data-inline-submenus');
    expect(screen.queryByRole('menuitem', { name: /^Model/ })).toBeNull();
    expect(menu.querySelector('[aria-haspopup="menu"]')).toBeNull();
    const group = screen.getByRole('group', { name: 'Model' });
    expect(group).toContainElement(screen.getByRole('menuitemradio', { name: /Default model/ }));
    // A long model list scrolls in its own box, so the rest of the menu stays in view.
    expect(group.closest('[data-inline-models]')).toHaveClass('max-h-48', 'overflow-y-auto');
    await user.click(screen.getByRole('menuitemradio', { name: /gpt-x/ }));
    expect(setModel).toHaveBeenCalledWith('gpt-x');
    await user.click(trigger);
    await screen.findByRole('menu');
    expect(screen.getByText('Favourites')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Prompt library…' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'VPN anomalies' }));
    expect(onUsePrompt).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('keeps the submenus where there is room for them', async () => {
    prefs.current = null;
    phoneWidth(false);
    const { user, trigger } = renderOptions({ canChooseModel: true, modelsState: 'ready', prompts: savedPrompts as unknown as ComposerOptionsProps['prompts'] });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    expect(menu).not.toHaveAttribute('data-inline-submenus');
    expect(screen.getByRole('menuitem', { name: /Model/ })).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getByRole('menuitem', { name: 'Prompts' })).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.queryByRole('menuitem', { name: 'VPN anomalies' })).toBeNull();
  });
});
