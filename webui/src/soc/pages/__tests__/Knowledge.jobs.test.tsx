/** Knowledge long-running mutations submit one durable server-owned job. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  submitJob: vi.fn(),
  get: vi.fn(),
  ragStats: vi.fn(),
  ragDocuments: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.get,
      ragStats: mocks.ragStats,
      ragDocuments: mocks.ragDocuments,
      jobs: {
        ...actual.api.jobs,
        submit: mocks.submitJob,
      },
    },
  };
});

vi.mock('@/soc/components/Can', () => ({
  useCan: () => true,
  Can: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import Knowledge, { ImportCard } from '../Knowledge';
import { TooltipProvider } from '@/ui/tooltip';

describe('Knowledge durable jobs', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.submitJob.mockResolvedValue({
      job_id: 'job-knowledge',
      kind: 'rag_import',
      status: 'queued',
    });
    mocks.ragStats.mockResolvedValue({
      total_chunks: 0,
      document_count: 0,
      by_source: {},
    });
    mocks.ragDocuments.mockResolvedValue({ documents: [], count: 0 });
  });

  it('submits a multi-file import once and clears it only after acceptance', async () => {
    render(<ImportCard />);
    const alpha = new File(['alpha text'], 'alpha.md', { type: 'text/markdown' });
    const beta = new File(['beta text'], 'beta.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByLabelText(/upload files/i), {
      target: { files: [alpha, beta] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /queue 2 documents/i }));

    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob).toHaveBeenCalledWith({
      kind: 'rag_import',
      idempotency_key: expect.any(String),
      params: {
        documents: [
          { title: 'alpha', text: 'alpha text', source: undefined, tags: [] },
          { title: 'beta', text: 'beta text', source: undefined, tags: [] },
        ],
      },
    });
    expect(screen.queryByText(/2 files queued/i)).not.toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/2 documents queued/i),
      expect.objectContaining({ description: expect.stringMatching(/server/i) }),
    );
  });

  it('rejects more than twenty documents before creating a server job', async () => {
    render(<ImportCard />);
    const files = Array.from(
      { length: 21 },
      (_, index) => new File([`doc ${index}`], `doc-${index}.txt`, { type: 'text/plain' }),
    );

    fireEvent.change(screen.getByLabelText(/upload files/i), {
      target: { files },
    });

    expect(
      await screen.findByText(/select at most 20 documents per import job/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /queue document/i })).toBeDisabled();
    expect(mocks.submitJob).not.toHaveBeenCalled();
  });

  it('requires the exact precedent acknowledgement and submits one bootstrap job', async () => {
    const acknowledgement = 'I UNDERSTAND THIS CREATES LOWER TRUST PRECEDENT';
    mocks.get.mockResolvedValue({
      tier_enabled: true,
      use_resolved_cases: true,
      use_unconfirmed_resolved_cases: true,
      trust_class: 'unconfirmed_precedent',
      provenance: 'model_outcome',
      acknowledgement_required: acknowledgement,
      max_batch: 500,
      guards: {},
      does_not: ['Does not create analyst feedback.'],
      eligible: 320,
      pending: 220,
    });

    render(
      <TooltipProvider>
        <Knowledge embedded />
      </TooltipProvider>,
    );
    const start = await screen.findByRole('button', { name: /start bootstrap job/i });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/exact acknowledgement/i), {
      target: { value: acknowledgement },
    });
    expect(start).toBeEnabled();
    fireEvent.click(start);

    await waitFor(() => expect(mocks.submitJob).toHaveBeenCalledTimes(1));
    expect(mocks.submitJob).toHaveBeenCalledWith({
      kind: 'precedent_bootstrap',
      idempotency_key: expect.any(String),
      params: {
        acknowledgement,
        limit: 200,
        dry_run: false,
      },
    });
  });
});
