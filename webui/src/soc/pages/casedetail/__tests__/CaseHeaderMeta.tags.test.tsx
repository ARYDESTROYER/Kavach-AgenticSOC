/**
 * Case header tag editor (Round 12 polish, tour finding 9).
 *
 * The header's "Add a tag" field used `maxLength={40}`, which cuts a pasted tag
 * silently, and it cleared the field before the save landed, so a refused save lost
 * what was typed. Now a longer tag is refused with a message (and never sent), and
 * the text stays in the field until the save succeeds. A case holds up to 25 tags; at
 * the cap the field says so rather than letting Add fail on the server's 422.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, caseTags: vi.fn() } };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';
import { CASE_TAG_MAX_COUNT } from '@/lib/tags';
import { CaseHeaderMeta } from '../CaseHeaderMeta';

const CASE = {
  case_id: 'case-1',
  status: 'open',
  verdict: 'needs_human',
  risk_score: 40,
  tags: ['existing'],
} as unknown as Case;

function renderMeta(onCaseChange = vi.fn(), c: Case = CASE) {
  render(
    <TooltipProvider>
      <CaseHeaderMeta
        c={c}
        outcome={caseOutcome(c)}
        users={[]}
        canAssign={false}
        canTag
        onCaseChange={onCaseChange}
        ownerOpen={false}
        onOwnerOpenChange={vi.fn()}
        tagsOpen
        onTagsOpenChange={vi.fn()}
      />
    </TooltipProvider>,
  );
  return screen.getByRole('textbox', { name: 'New tag' });
}

describe('case header tag editor', () => {
  beforeEach(() => vi.mocked(api.caseTags).mockReset());

  it('refuses a tag over 40 characters with a message and never cuts or sends it', () => {
    const input = renderMeta();
    expect(input).not.toHaveAttribute('maxlength');
    const sentence = 'Scheduled vendor API sync from the known service account';
    fireEvent.change(input, { target: { value: sentence } });
    expect(screen.getByRole('alert')).toHaveTextContent('This is longer than 40 characters. Shorten it to add it.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(api.caseTags).not.toHaveBeenCalled();
    expect(input).toHaveValue(sentence);
  });

  it('keeps the typed tag when the save is refused, and clears it once saved', async () => {
    vi.mocked(api.caseTags).mockRejectedValueOnce(new Error('Could not save the tags.'));
    const onCaseChange = vi.fn();
    const input = renderMeta(onCaseChange);
    fireEvent.change(input, { target: { value: 'vendor-sync' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.caseTags).toHaveBeenCalledWith('case-1', ['existing', 'vendor-sync']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled());
    expect(input).toHaveValue('vendor-sync');

    vi.mocked(api.caseTags).mockResolvedValueOnce({ ...CASE, tags: ['existing', 'vendor-sync'] } as Case);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onCaseChange).toHaveBeenCalled());
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('says a full case holds no more tags instead of letting Add fail', () => {
    // The server refuses a 26th tag (422); the field says why before anything is sent.
    const full = { ...CASE, tags: Array.from({ length: CASE_TAG_MAX_COUNT }, (_, i) => `t${i}`) } as Case;
    const input = renderMeta(vi.fn(), full);
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    const note = screen.getByText(
      `A case can hold up to ${CASE_TAG_MAX_COUNT} tags, and this one has ${CASE_TAG_MAX_COUNT}. Remove one to add another.`,
    );
    expect(input.getAttribute('aria-describedby')).toContain(note.id);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(api.caseTags).not.toHaveBeenCalled();
  });
});
