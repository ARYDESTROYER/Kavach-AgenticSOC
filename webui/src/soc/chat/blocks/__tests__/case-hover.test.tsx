/**
 * The lazy case preview never costs a keyboard user their focus.
 *
 * Wrapping a case link in `CaseHoverCard` remounts the link. The kit therefore holds the
 * swap back while focus is inside the case-bearing block and arms it the moment focus
 * leaves. Kept in its own file: the loaded preview is cached per module, and the first
 * test here must see it unloaded.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));

import AnswerBlocks from '../AnswerBlocks';
import { galleryBlock } from '../__fixtures__/gallery';

const TITLE = 'Brute force against vpn-gw-2';

describe('case hover preview arming', () => {
  it('keeps a focused case link mounted (and focused) while the pointer arms the preview', async () => {
    render(<AnswerBlocks blocks={[galleryBlock('open-cases')]} messageId="m1" />);
    const link = screen.getByRole('link', { name: TITLE });
    act(() => link.focus());
    expect(document.activeElement).toBe(link);

    const arm = screen.getByTestId('block-case-list').parentElement!;
    await act(async () => {
      fireEvent.pointerEnter(arm);
      // Let the preview chunk resolve and the arm callback run.
      await import('@/soc/components/CaseHoverCard');
      await Promise.resolve();
      await Promise.resolve();
    });

    // Same node, still focused, not yet wrapped by the hover-card trigger.
    expect(screen.getByRole('link', { name: TITLE })).toBe(link);
    expect(document.activeElement).toBe(link);
    expect(link).not.toHaveAttribute('data-state');

    // Focus leaves the block: now the preview arms (the trigger gains Radix state).
    act(() => link.blur());
    await waitFor(() => expect(screen.getByRole('link', { name: TITLE })).toHaveAttribute('data-state', 'closed'));
  });

  it('arms a later block at once, without any swap, once the preview is loaded', () => {
    render(<AnswerBlocks blocks={[galleryBlock('open-cases')]} messageId="m2" />);
    expect(screen.getByRole('link', { name: TITLE })).toHaveAttribute('data-state', 'closed');
  });
});
