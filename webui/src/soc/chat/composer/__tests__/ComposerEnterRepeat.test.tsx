/**
 * A held Enter never sends (Round 12 WP-ASK review): the palette's "Ask AI: <text>"
 * hand-off prefills and focuses the composer while the Enter that chose it may still be
 * down, and the browser's auto-repeat (`event.repeat`) then lands in this field. A
 * repeated keydown is a no-op (it never inserts a line either); a fresh press sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const announce = vi.hoisted(() => vi.fn());
vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => announce }));

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Harness, makeSpies, stubServer } from './harness';
import { makeContext } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Let the composer's own source and model reads land inside act(). */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe('Composer — auto-repeated Enter', () => {
  it('ignores a repeated Enter on a prefilled draft and sends on a fresh press', async () => {
    stubServer();
    const spies = makeSpies();
    const question = 'Which hosts failed logins most today?';
    render(<Harness spies={spies} context={makeContext()} draft={question} />);
    await settle();
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement;
    act(() => textarea.focus());
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true });
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true });
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe(question);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it('still lets a held Shift+Enter add lines', async () => {
    stubServer();
    const spies = makeSpies();
    render(<Harness spies={spies} context={makeContext()} draft="first" />);
    await settle();
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' });
    // Shift+Enter is the browser's own newline (not prevented), repeat or not.
    const event = fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true, repeat: true });
    expect(event).toBe(true);
    expect(spies.send).not.toHaveBeenCalled();
  });
});
