/**
 * useReturnFocus (Round 14, SPEC §3.3): a controlled sheet or dialog hands focus back to
 * what opened it; when the opener has left the page with its row (a confirmed delete),
 * focus goes to the row that took its place, else the list's heading, never the body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { REMOVAL_WATCH_MS, headingOf, openerFromElement, useReturnFocus } from '../useReturnFocus';

function closeEvent(): Event {
  return new Event('focusScope.autoFocusOnUnmount', { cancelable: true });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** A list of rows, each with a Delete button, under a panel heading. */
function mountList(rows: string[]): HTMLElement {
  document.body.innerHTML = `
    <section id="panel"><h2 id="title">Saved memories</h2>
      <ul>${rows.map((id) => `<li id="row-${id}"><button data-delete id="del-${id}">Delete</button></li>`).join('')}</ul>
    </section>`;
  return document.getElementById('panel') as HTMLElement;
}

const peersIn = (panel: HTMLElement) => ({
  peers: () => panel.querySelectorAll('[data-delete]'),
  empty: () => headingOf(panel),
});

describe('openerFromElement', () => {
  it('returns a plain focused control as the opener', () => {
    document.body.innerHTML = '<button id="b">Open</button>';
    const button = document.getElementById('b');
    expect(openerFromElement(button)).toBe(button);
  });

  it("resolves a menu item to the button that opened its menu (the item leaves with the menu)", () => {
    document.body.innerHTML = `
      <button id="trigger">More actions</button>
      <div role="menu" aria-labelledby="trigger"><div role="menuitem" id="item" tabindex="-1">Edit</div></div>`;
    expect(openerFromElement(document.getElementById('item'))).toBe(document.getElementById('trigger'));
  });

  it('gives no opener for the page body or a menu without a labelling trigger', () => {
    expect(openerFromElement(document.body)).toBeNull();
    document.body.innerHTML = '<div role="menu"><div role="menuitem" id="item">Edit</div></div>';
    expect(openerFromElement(document.getElementById('item'))).toBeNull();
  });
});

describe('useReturnFocus', () => {
  it('focuses the remembered opener on close and prevents the default', () => {
    document.body.innerHTML = '<button id="b">Open</button>';
    const button = document.getElementById('b') as HTMLButtonElement;
    button.focus();
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember();
    button.blur();
    const event = closeEvent();
    result.current.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('resolves a finder when the layer closes, so a re-rendered row still receives focus', () => {
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(() => document.getElementById('late'));
    document.body.innerHTML = '<button id="late">Row</button>';
    result.current.onCloseAutoFocus(closeEvent());
    expect(document.activeElement).toBe(document.getElementById('late'));
  });

  it('keeps the default when the opener has left the page, and after an explicit clear', () => {
    document.body.innerHTML = '<button id="b">Open</button>';
    const button = document.getElementById('b') as HTMLButtonElement;
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(button);
    button.remove();
    const gone = closeEvent();
    result.current.onCloseAutoFocus(gone);
    expect(gone.defaultPrevented).toBe(false);

    document.body.appendChild(button);
    result.current.remember(button);
    result.current.remember(null);
    const cleared = closeEvent();
    result.current.onCloseAutoFocus(cleared);
    expect(cleared.defaultPrevented).toBe(false);
  });

  it('exposes the opener as a ref, null once it has left the page', () => {
    document.body.innerHTML = '<button id="b">Open</button>';
    const button = document.getElementById('b') as HTMLButtonElement;
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(button);
    expect(result.current.ref.current).toBe(button);
    button.remove();
    expect(result.current.ref.current).toBeNull();
  });
});

describe('useReturnFocus fallback when the opener leaves with its row', () => {
  it("focuses the row that took the deleted row's place", () => {
    const panel = mountList(['a', 'b', 'c']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-b'), peersIn(panel));
    document.getElementById('row-b')?.remove();
    const event = closeEvent();
    result.current.onCloseAutoFocus(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('del-c'));
  });

  it('takes the last row when the deleted row was the last one', () => {
    const panel = mountList(['a', 'b']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-b'), peersIn(panel));
    document.getElementById('row-b')?.remove();
    result.current.onCloseAutoFocus(closeEvent());
    expect(document.activeElement).toBe(document.getElementById('del-a'));
  });

  it("focuses the list's heading (a script-only stop) when no row is left", () => {
    const panel = mountList(['a']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    document.getElementById('row-a')?.remove();
    result.current.onCloseAutoFocus(closeEvent());
    const title = document.getElementById('title');
    expect(document.activeElement).toBe(title);
    expect(title).toHaveAttribute('tabindex', '-1');
  });

  it('still prefers the opener while it is on the page', () => {
    const panel = mountList(['a', 'b']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    result.current.onCloseAutoFocus(closeEvent());
    expect(document.activeElement).toBe(document.getElementById('del-a'));
  });

  it('resolves the ref to the fallback, made focusable, once the opener has gone', () => {
    const panel = mountList(['a']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    document.getElementById('row-a')?.remove();
    const target = result.current.ref.current;
    expect(target).toBe(document.getElementById('title'));
    expect(target).toHaveAttribute('tabindex', '-1');
  });

  it('gives headingOf the panel itself when it has no heading', () => {
    document.body.innerHTML = '<div id="p"><p>Empty</p></div>';
    const panel = document.getElementById('p');
    expect(headingOf(panel)).toBe(panel);
    expect(headingOf(null)).toBeNull();
  });
});

describe('useReturnFocus expectRemoval (the list reloads after the layer closed)', () => {
  it('moves focus that fell to the body to the next row once the opener leaves', async () => {
    const panel = mountList(['a', 'b']);
    const opener = document.getElementById('del-a') as HTMLButtonElement;
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(opener, peersIn(panel));
    // The dialog closed and handed focus back to the opener; the delete is confirmed.
    opener.focus();
    result.current.expectRemoval();
    await act(async () => {
      document.getElementById('row-a')?.remove();
    });
    expect(document.activeElement).toBe(document.getElementById('del-b'));
  });

  it('never takes focus the reader has moved elsewhere', async () => {
    const panel = mountList(['a', 'b']);
    document.body.insertAdjacentHTML('beforeend', '<input id="search" />');
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    result.current.expectRemoval();
    const search = document.getElementById('search') as HTMLInputElement;
    search.focus();
    await act(async () => {
      document.getElementById('row-a')?.remove();
    });
    expect(document.activeElement).toBe(search);
  });

  it('does nothing while the opener stays (a failed delete) and stops on the next remember', async () => {
    const panel = mountList(['a', 'b']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    result.current.expectRemoval();
    await act(async () => {
      document.getElementById('row-b')?.remove();
    });
    expect(document.activeElement).toBe(document.body);
    // A new opener ends the watch: removing the old row later moves nothing.
    result.current.remember(document.getElementById('del-a'));
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      document.getElementById('row-a')?.remove();
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('gives up after the watch window', async () => {
    vi.useFakeTimers();
    const panel = mountList(['a', 'b']);
    const { result } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    result.current.expectRemoval();
    vi.advanceTimersByTime(REMOVAL_WATCH_MS + 1);
    vi.useRealTimers();
    await act(async () => {
      document.getElementById('row-a')?.remove();
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('stops watching on unmount', async () => {
    const panel = mountList(['a', 'b']);
    const { result, unmount } = renderHook(() => useReturnFocus());
    result.current.remember(document.getElementById('del-a'), peersIn(panel));
    result.current.expectRemoval();
    unmount();
    await act(async () => {
      document.getElementById('row-a')?.remove();
    });
    expect(document.activeElement).toBe(document.body);
  });
});
