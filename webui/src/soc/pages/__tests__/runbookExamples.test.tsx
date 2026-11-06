/**
 * Runbook files to download (Round 14, SPEC §4.10.13): the downloadable examples of the
 * retired page are replaced by "Export all as Markdown", one `<id>.md` per runbook in a
 * single archive, each file the server's own export (which reads back to the same runbook).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listRunbookLibrary: vi.fn(),
  getRunbookMetrics: vi.fn(),
  exportRunbookMarkdown: vi.fn(),
  downloadBlob: vi.fn(),
}));

vi.mock('@/lib/api-runbooks', () => ({
  listRunbookLibrary: mocks.listRunbookLibrary,
  getRunbookMetrics: mocks.getRunbookMetrics,
  exportRunbookMarkdown: mocks.exportRunbookMarkdown,
  importRunbook: vi.fn(),
}));
vi.mock('@/lib/download-blob', () => ({ downloadBlob: mocks.downloadBlob }));
vi.mock('@/soc/components/Can', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/soc/components/Can')>();
  return { ...actual, useCan: () => true };
});

import { TooltipProvider } from '@/ui/tooltip';
import Runbooks from '../Runbooks';
import { makeSummary } from '@/soc/runbooks/editor/__tests__/fixtures';
import { exportRunbookMarkdown as exportLocally, parseRunbookMarkdown } from '@/soc/runbooks/editor/markdown';
import { makeDefinition } from '@/soc/runbooks/editor/__tests__/fixtures';

const IDS = ['brute-force-password-spray', 'phishing-triage'];

beforeEach(() => {
  mocks.listRunbookLibrary.mockReset().mockResolvedValue({
    runbooks: IDS.map((id) => makeSummary({ id, title: id })),
    migration: null,
  });
  mocks.getRunbookMetrics.mockReset().mockResolvedValue({
    window_label: 'Last 30 days',
    partial: false,
    per_runbook: [],
    per_phase: [],
    per_step: [],
    coverage: { cases_with_run: 0, human_handled_cases: 0 },
    rules_without_runbook: [],
    cohorts: { with_completed_run: { cases: 0, mttr_p50_minutes: null }, without: { cases: 0, mttr_p50_minutes: null }, note: 'comparison, not cause' },
    recent_runs: [],
  });
  mocks.exportRunbookMarkdown.mockReset().mockImplementation(async (id: string) => ({
    blob: new Blob([exportLocally(makeDefinition({ id }), 1)], { type: 'text/markdown' }),
    contentDisposition: `attachment; filename="${id}.md"`,
    contentType: 'text/markdown',
  }));
  mocks.downloadBlob.mockReset().mockReturnValue(true);
});

describe('Export all as Markdown', () => {
  it('puts one file per runbook in one archive', async () => {
    render(
      <TooltipProvider>
        <Runbooks />
      </TooltipProvider>,
    );
    await screen.findByText('phishing-triage');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export all as Markdown' }));
    await waitFor(() => expect(mocks.downloadBlob).toHaveBeenCalledTimes(1));
    expect(mocks.exportRunbookMarkdown.mock.calls.map((c) => c[0]).sort()).toEqual(IDS);
    const [name, blob] = mocks.downloadBlob.mock.calls[0] as [string, Blob];
    expect(name).toMatch(/^runbooks-\d{4}-\d{2}-\d{2}\.zip$/);
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blob);
    });
    const text = new TextDecoder('latin1').decode(bytes);
    for (const id of IDS) expect(text).toContain(`${id}.md`);
  });

  it('exports files that read back to the same runbook', () => {
    const defn = makeDefinition();
    const parsed = parseRunbookMarkdown(exportLocally(defn, 2));
    expect(parsed.issues.filter((i) => i.code !== 'unknown_key')).toEqual([]);
    expect(parsed.version).toBe(2);
    expect(parsed.definition?.steps.map((s) => s.id)).toEqual(defn.steps.map((s) => s.id));
  });
});
