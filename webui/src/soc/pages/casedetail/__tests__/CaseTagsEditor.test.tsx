/**
 * The case tag editor (Round 12 polish, tour finding 9; Round 15 D8.2/D8.4: it moved from
 * the header's meta row to the facts rail's Tags section).
 *
 * A longer tag is refused with a message (and never sent), and the text stays in the
 * field until the save succeeds. A case holds up to 25 tags; at the cap the field says so
 * rather than letting Add fail on the server's 422. The header's meta row no longer
 * carries tags, the campaign, the risk reading, Ask AI or the Sample mark.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
import { CaseTagsEditor } from '../CaseTagsEditor';
import { CaseHeaderMeta } from '../CaseHeaderMeta';

const CASE = {
  case_id: 'case-1',
  status: 'open',
  verdict: 'needs_human',
  risk_score: 40,
  tags: ['existing'],
} as unknown as Case;

function renderEditor(onCaseChange = vi.fn(), c: Case = CASE) {
  render(
    <TooltipProvider>
      <CaseTagsEditor c={c} canTag onCaseChange={onCaseChange} open onOpenChange={vi.fn()} />
    </TooltipProvider>,
  );
  return screen.getByRole('textbox', { name: 'New tag' });
}

describe('case tag editor', () => {
  beforeEach(() => vi.mocked(api.caseTags).mockReset());

  it('refuses a tag over 40 characters with a message and never cuts or sends it', () => {
    const input = renderEditor();
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
    const input = renderEditor(onCaseChange);
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
    const input = renderEditor(vi.fn(), full);
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    const note = screen.getByText(
      `A case can hold up to ${CASE_TAG_MAX_COUNT} tags, and this one has ${CASE_TAG_MAX_COUNT}. Remove one to add another.`,
    );
    expect(input.getAttribute('aria-describedby')).toContain(note.id);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(api.caseTags).not.toHaveBeenCalled();
  });

  it('removes a tag from the editor through the tags route', async () => {
    vi.mocked(api.caseTags).mockResolvedValueOnce({ ...CASE, tags: [] } as Case);
    const onCaseChange = vi.fn();
    renderEditor(onCaseChange);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag existing' }));
    await waitFor(() => expect(api.caseTags).toHaveBeenCalledWith('case-1', []));
    await waitFor(() => expect(onCaseChange).toHaveBeenCalled());
  });

  it('shows the tags read-only, with no editor, to a viewer who cannot edit them', () => {
    render(
      <TooltipProvider>
        <CaseTagsEditor c={CASE} canTag={false} onCaseChange={vi.fn()} open={false} onOpenChange={vi.fn()} />
      </TooltipProvider>,
    );
    expect(within(screen.getByRole('list', { name: 'Tags' })).getByText('existing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit tags|Add a tag/ })).toBeNull();
  });

  it('offers "Add a tag" when the case has none, with T as its shortcut', () => {
    render(
      <TooltipProvider>
        <CaseTagsEditor
          c={{ ...CASE, tags: [] } as Case}
          canTag
          onCaseChange={vi.fn()}
          open={false}
          onOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('No tags')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a tag' })).toHaveAttribute('aria-keyshortcuts', 'T');
  });
});

describe('the header meta row (D8.2)', () => {
  it('carries no tags, campaign, risk reading, Ask AI or Sample mark: they live in the facts rail', () => {
    const demo = { ...CASE, case_number: 'CASE-000001', tags: ['demo', 'existing'], severity_band: 'high' } as Case;
    render(
      <TooltipProvider>
        <CaseHeaderMeta
          c={demo}
          outcome={caseOutcome(demo)}
          users={[]}
          canAssign={false}
          onCaseChange={vi.fn()}
          ownerOpen={false}
          onOwnerOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    const meta = screen.getByTestId('case-detail-meta');
    expect(meta).toHaveTextContent('CASE-000001');
    expect(meta).toHaveTextContent('High severity');
    expect(within(meta).getByTestId('case-detail-status')).toHaveTextContent('Open');
    expect(within(meta).queryByTestId('case-detail-tags')).toBeNull();
    expect(within(meta).queryByTestId('case-detail-risk')).toBeNull();
    expect(meta).not.toHaveTextContent('SAMPLE');
    expect(meta).not.toHaveTextContent('existing');
    expect(within(meta).queryByRole('button', { name: /Ask AI/ })).toBeNull();
    // The owner is its one editable home.
    expect(within(meta).getByTestId('case-detail-owner')).toHaveAttribute('aria-keyshortcuts', 'M');
  });

  it('shows the outcome of an ended case in place of its status, never both', () => {
    const closed = {
      ...CASE,
      status: 'closed',
      decision_by: 'analyst',
      disposition: 'false_positive',
      history: [{ event: 'analyst_action', action: 'close', analyst: 'aryan', ts: '2026-10-10T10:00:00Z', classified_disposition: 'false_positive' }],
    } as unknown as Case;
    render(
      <TooltipProvider>
        <CaseHeaderMeta
          c={closed}
          outcome={caseOutcome(closed)}
          users={[]}
          canAssign={false}
          onCaseChange={vi.fn()}
          ownerOpen={false}
          onOwnerOpenChange={vi.fn()}
        />
      </TooltipProvider>,
    );
    const meta = screen.getByTestId('case-detail-meta');
    expect(within(meta).queryByTestId('case-detail-status')).toBeNull();
    expect(within(meta).getByTestId('case-outcome')).toHaveTextContent('False positive');
    // No SLA countdown once the case ended.
    expect(within(meta).queryByTestId('case-detail-sla')).toBeNull();
  });
});
