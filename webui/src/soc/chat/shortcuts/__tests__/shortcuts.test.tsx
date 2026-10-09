/**
 * Chat keyboard shortcuts (SPEC §10.4a): Ctrl/Cmd+Shift+O new chat, Ctrl/Cmd+Shift+S
 * toggle history, Shift+Esc focus composer, Ctrl/Cmd+/ the sheet; never Ctrl/Cmd+K or
 * B; nothing while an input method composes, on repeat, after another handler
 * consumed the key, or while a modal layer owns the keyboard; registered only while
 * enabled. The sheet lists every shortcut, including the composer keys.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { CHAT_SHORTCUTS, keyLabel, shortcutLabel } from '../shortcut-list';
import { ShortcutSheet } from '../ShortcutSheet';
import {
  anyLayerOpen,
  CHAT_KEYSHORTCUTS,
  matchChatShortcut,
  modalLayerOpen,
  useChatShortcuts,
  type ChatShortcutHandlers,
} from '../useChatShortcuts';

expect.extend(toHaveNoViolations);

const key = (init: Partial<KeyboardEvent>) => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  repeat: false,
  defaultPrevented: false,
  ...init,
});

describe('matchChatShortcut', () => {
  it('maps the four shortcuts with Ctrl or Cmd', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(matchChatShortcut(key({ ...mod, shiftKey: true, key: 'O' }))).toBe('newChat');
      expect(matchChatShortcut(key({ ...mod, shiftKey: true, key: 's' }))).toBe('toggleHistory');
      expect(matchChatShortcut(key({ ...mod, key: '/' }))).toBe('openShortcuts');
    }
    expect(matchChatShortcut(key({ shiftKey: true, key: 'Escape' }))).toBe('focusComposer');
    // Non-Latin layouts (the key is not a Latin character) still match the physical key.
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Ø', code: 'KeyO' }))).toBe('newChat');
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Щ', code: 'KeyO' }))).toBe('newChat');
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Ы', code: 'KeyS' }))).toBe('toggleHistory');
    // A Latin layout's own character wins: Dvorak types "o" on the physical S key.
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'O', code: 'KeyS' }))).toBe('newChat');
  });

  it('never takes over a Latin layout key through its physical position', () => {
    // German/Spanish/Italian/Nordic: the "/" position types "-" (Ctrl+- is zoom out).
    expect(matchChatShortcut(key({ ctrlKey: true, key: '-', code: 'Slash' }))).toBeNull();
    // Dvorak: the "/" position types "z" (Ctrl+Z is undo in the composer).
    expect(matchChatShortcut(key({ ctrlKey: true, key: 'z', code: 'Slash' }))).toBeNull();
    // Dvorak: the physical O types "r" (Ctrl+Shift+R is a hard reload).
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'R', code: 'KeyO' }))).toBeNull();
    expect(matchChatShortcut(key({ metaKey: true, shiftKey: true, key: 'r', code: 'KeyO' }))).toBeNull();
    // Named keys never fall back to the physical position.
    expect(matchChatShortcut(key({ ctrlKey: true, key: 'Dead', code: 'Slash' }))).toBeNull();
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'Unidentified', code: 'KeyO' }))).toBeNull();
    // A non-Latin layout's physical K/B stay the console's.
    expect(matchChatShortcut(key({ ctrlKey: true, key: 'л', code: 'KeyK' }))).toBeNull();
  });

  it('does not prevent a Latin-layout browser shortcut that shares the physical key', () => {
    const h = {
      newChat: vi.fn(),
      toggleHistory: vi.fn(),
      focusComposer: vi.fn(),
      openShortcuts: vi.fn(),
    };
    const { unmount } = renderHook(() => useChatShortcuts(h));
    const zoomOut = new KeyboardEvent('keydown', { key: '-', code: 'Slash', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(zoomOut);
    const reload = new KeyboardEvent('keydown', { key: 'R', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(reload);
    expect(zoomOut.defaultPrevented).toBe(false);
    expect(reload.defaultPrevented).toBe(false);
    expect(h.openShortcuts).not.toHaveBeenCalled();
    expect(h.newChat).not.toHaveBeenCalled();
    unmount();
  });

  it('never claims Ctrl/Cmd+K or B in any combination', () => {
    for (const k of ['k', 'K', 'b', 'B']) {
      for (const mods of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, shiftKey: true }]) {
        expect(matchChatShortcut(key({ ...mods, key: k }))).toBeNull();
      }
    }
  });

  it('ignores composing, repeated, consumed and Alt events, and plain keys', () => {
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'o', isComposing: true }))).toBeNull();
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'o', keyCode: 229 }))).toBeNull();
    expect(matchChatShortcut(key({ ctrlKey: true, shiftKey: true, key: 'o', repeat: true }))).toBeNull();
    expect(matchChatShortcut(key({ shiftKey: true, key: 'Escape', defaultPrevented: true }))).toBeNull();
    expect(matchChatShortcut(key({ ctrlKey: true, altKey: true, key: '/' }))).toBeNull();
    expect(matchChatShortcut(key({ key: 'Escape' }))).toBeNull();
    expect(matchChatShortcut(key({ shiftKey: true, key: 'O' }))).toBeNull();
  });
});

describe('useChatShortcuts', () => {
  const handlers = (): ChatShortcutHandlers => ({
    newChat: vi.fn(),
    toggleHistory: vi.fn(),
    focusComposer: vi.fn(),
    openShortcuts: vi.fn(),
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('calls the handler and prevents the browser default', () => {
    const h = handlers();
    renderHook(() => useChatShortcuts(h));
    const event = new KeyboardEvent('keydown', { key: 'O', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(h.newChat).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.keyDown(window, { key: 'S', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: '/', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Escape', shiftKey: true });
    expect(h.toggleHistory).toHaveBeenCalledTimes(1);
    expect(h.openShortcuts).toHaveBeenCalledTimes(1);
    expect(h.focusComposer).toHaveBeenCalledTimes(1);
  });

  it('registers nothing while disabled and unregisters on unmount', () => {
    const h = handlers();
    const { rerender, unmount } = renderHook(({ on }: { on: boolean }) => useChatShortcuts(h, on), {
      initialProps: { on: false },
    });
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(h.newChat).not.toHaveBeenCalled();
    rerender({ on: true });
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(h.newChat).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(h.newChat).toHaveBeenCalledTimes(1);
  });

  it('leaves the keyboard to an open modal dialog or a focused menu', () => {
    const h = handlers();
    renderHook(() => useChatShortcuts(h));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    expect(modalLayerOpen()).toBe(true);
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(h.newChat).not.toHaveBeenCalled();
    // A popover (inside a popper wrapper) without focus does not block shortcuts.
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    wrapper.appendChild(dialog);
    document.body.appendChild(wrapper);
    expect(modalLayerOpen()).toBe(false);
    expect(anyLayerOpen()).toBe(true);
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(h.newChat).toHaveBeenCalledTimes(1);
  });

  it('exposes aria-keyshortcuts values for the owning controls', () => {
    expect(CHAT_KEYSHORTCUTS).toEqual({
      newChat: 'Control+Shift+O Meta+Shift+O',
      toggleHistory: 'Control+Shift+S Meta+Shift+S',
      focusComposer: 'Shift+Escape',
      openShortcuts: 'Control+/ Meta+/',
    });
  });
});

describe('shortcut list', () => {
  it('documents every shortcut, composer keys included, and none uses K or B', () => {
    const ids = CHAT_SHORTCUTS.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(['send', 'newline', 'edit-last', 'stop', 'focus', 'new-chat', 'toggle-history', 'shortcuts']),
    );
    for (const s of CHAT_SHORTCUTS) {
      expect(s.keys.includes('Mod') && s.keys.some((k) => k === ('K' as never) || k === ('B' as never))).toBe(false);
    }
  });

  it('labels keys per platform', () => {
    expect(shortcutLabel(['Mod', 'Shift', 'O'], false)).toBe('Ctrl+Shift+O');
    expect(shortcutLabel(['Mod', 'Shift', 'O'], true)).toBe('⌘⇧O');
    expect(keyLabel('Esc', true)).toBe('Esc');
  });
});

describe('ShortcutSheet', () => {
  it('lists every shortcut with its keys and passes axe', async () => {
    const onOpenChange = vi.fn();
    render(<ShortcutSheet open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const shortcut of CHAT_SHORTCUTS) {
      expect(within(dialog).getByText(shortcut.label)).toBeInTheDocument();
    }
    const terms = within(dialog).getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(expect.arrayContaining(['Send', 'New line', 'Edit your last prompt (in an empty composer)', 'Stop the answer (while it runs)']));
    const send = within(dialog).getByText('Send').closest('div') as HTMLElement;
    expect(within(send).getByText('Enter').tagName).toBe('KBD');
    const newline = within(dialog).getByText('New line').closest('div') as HTMLElement;
    expect(within(newline).getAllByText(/Shift|⇧|Enter/).map((k) => k.tagName)).toEqual(['KBD', 'KBD']);
    expect(await axe(document.body, { rules: { region: { enabled: false } } })).toHaveNoViolations();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when closed', () => {
    render(<ShortcutSheet open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Keeps React happy about the unused import in type-only builds.
    expect(React.isValidElement(<ShortcutSheet open={false} onOpenChange={() => {}} />)).toBe(true);
  });
});
