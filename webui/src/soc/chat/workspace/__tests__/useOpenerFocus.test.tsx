/**
 * useOpenerFocus (Round 13, SPEC-chat T27): `capture` records the opener and, given the
 * open event, focuses the content's `[data-autofocus]` element instead of Radix's first
 * focusable one (the History sheet's search field, so no New chat tooltip opens); without
 * a marked element, or called without an event, Radix's default stands. `restore` returns
 * focus to the opener.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOpenerFocus } from '../useOpenerFocus';

function content(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('useOpenerFocus', () => {
  it('focuses the marked element on open and returns focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { result } = renderHook(() => useOpenerFocus());
    const sheet = content('<button>New chat</button><input data-autofocus aria-label="Search chats" />');
    const open = new CustomEvent('focusScope.autoFocusOnMount', { cancelable: true });
    sheet.dispatchEvent(open);
    // The event target is the content (Radix dispatches it on the focus scope).
    result.current.capture(Object.defineProperty(open, 'target', { value: sheet }));
    expect(open.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(sheet.querySelector('input'));
    const close = new CustomEvent('focusScope.autoFocusOnUnmount', { cancelable: true });
    result.current.restore(close);
    expect(close.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(opener);
    sheet.remove();
    opener.remove();
  });

  it('leaves Radix\'s default when nothing is marked or no event is passed', () => {
    const { result } = renderHook(() => useOpenerFocus());
    const sheet = content('<button>New chat</button>');
    const open = new CustomEvent('focusScope.autoFocusOnMount', { cancelable: true });
    result.current.capture(Object.defineProperty(open, 'target', { value: sheet }));
    expect(open.defaultPrevented).toBe(false);
    expect(() => result.current.capture()).not.toThrow();
    sheet.remove();
  });
});
