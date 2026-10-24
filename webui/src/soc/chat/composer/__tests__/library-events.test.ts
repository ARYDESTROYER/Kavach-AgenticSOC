/**
 * Prompt-library window events (Round 13 SPEC-chat §3.9, §5.2, §7.1): the start screen
 * opens the library filtered to a pill's categories and hands a `use_prompt` card's
 * prompt id to the composer. Details are untrusted: unknown categories and malformed
 * ids never reach a listener.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_PROMPT_LIBRARY_EVENT,
  PICK_LIBRARY_PROMPT_EVENT,
  onOpenPromptLibrary,
  onPickPromptFromLibrary,
  openPromptLibrary,
  pickPromptFromLibrary,
} from '../library-events';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('openPromptLibrary', () => {
  it('opens the whole library when called without categories (the existing call)', () => {
    const listener = vi.fn();
    cleanups.push(onOpenPromptLibrary(listener));
    openPromptLibrary();
    expect(listener).toHaveBeenCalledWith({});
  });

  it('passes known categories once, in order, and drops unknown ones', () => {
    const listener = vi.fn();
    cleanups.push(onOpenPromptLibrary(listener));
    openPromptLibrary({ categories: ['hunt', 'ioc', 'hunt'] });
    expect(listener).toHaveBeenLastCalledWith({ categories: ['hunt', 'ioc'] });
    window.dispatchEvent(new CustomEvent(OPEN_PROMPT_LIBRARY_EVENT, { detail: { categories: ['<b>', 7] } }));
    expect(listener).toHaveBeenLastCalledWith({});
  });

  it('stops listening after unsubscribe', () => {
    const listener = vi.fn();
    const off = onOpenPromptLibrary(listener);
    off();
    openPromptLibrary({ categories: ['posture'] });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('pickPromptFromLibrary', () => {
  it('hands a saved or library prompt id to the listener', () => {
    const listener = vi.fn();
    cleanups.push(onPickPromptFromLibrary(listener));
    pickPromptFromLibrary('p-1a2b3c');
    pickPromptFromLibrary('starter:book-morning');
    expect(listener.mock.calls).toEqual([[{ promptId: 'p-1a2b3c' }], [{ promptId: 'starter:book-morning' }]]);
  });

  it('never dispatches or delivers a malformed id', () => {
    const listener = vi.fn();
    cleanups.push(onPickPromptFromLibrary(listener));
    pickPromptFromLibrary('');
    pickPromptFromLibrary('a b');
    pickPromptFromLibrary('x'.repeat(65));
    window.dispatchEvent(new CustomEvent(PICK_LIBRARY_PROMPT_EVENT, { detail: { promptId: 'ok\n' } }));
    window.dispatchEvent(new CustomEvent(PICK_LIBRARY_PROMPT_EVENT, { detail: null }));
    expect(listener).not.toHaveBeenCalled();
  });
});
