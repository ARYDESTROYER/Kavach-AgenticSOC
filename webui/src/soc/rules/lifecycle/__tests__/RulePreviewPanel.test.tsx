/**
 * RulePreviewPanel spec (Round-5 G6, R5): the read-only, NO-COST rule preview.
 *
 * THE load-bearing assertion for this wave: running a preview hits ONLY the pure,
 * read-only `api.rules.preview` path. Every other method of the API client and of the
 * Round 14 runbook client is a spy, and none of them is called: no LLM path (chat,
 * investigate, reinvestigate), no case write (an action, a job) and no runbook run
 * write, so a preview bills ZERO UsageDoc (#6) and never closes or escalates a case
 * (#3). The spies are built from the real modules, so the check cannot name a method
 * that no longer exists or miss one that was added. It also renders the match count
 * and histogram from the pure endpoint's result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

// `vi.hoisted` lets these be referenced inside the hoisted `vi.mock` factories.
const h = vi.hoisted(() => {
  /** Every function in a module or client namespace as a spy, recursively. */
  const spyEverything = (value: unknown): unknown => {
    if (typeof value === 'function') return vi.fn();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, spyEverything(inner)]));
    }
    return value;
  };
  return {
    spyEverything,
    previewSpy: vi.fn(async () => ({
      scanned: 1000,
      matched: 42,
      match_rate: 0.042,
      histogram: [
        { bucket: '2026-07-01T00:00:00+00:00', count: 20 },
        { bucket: '2026-07-01T12:00:00+00:00', count: 22 },
      ],
      sample: [],
      predicates: 1,
      predicates_evaluated: 1,
      hard_capped: false,
    })),
  };
});
const { previewSpy } = h;

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const api = h.spyEverything(actual.api) as typeof actual.api;
  (api.rules as unknown as { preview: unknown }).preview = h.previewSpy;
  // LoadError formats a failed preview through `errorMessage`, which checks for ApiError.
  return { ...(h.spyEverything({ ...actual }) as object), ApiError: actual.ApiError, api };
});
vi.mock('@/lib/api-runbooks', async (importOriginal) => h.spyEverything({ ...(await importOriginal<object>()) }) as object);

import * as apiModule from '@/lib/api';
import * as runbookModule from '@/lib/api-runbooks';

/** The dotted names of every spy in `value` that was called. */
function calledSpies(value: unknown, path: string[] = []): string[] {
  if (vi.isMockFunction(value)) return value.mock.calls.length ? [path.join('.')] : [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, inner]) => calledSpies(inner, [...path, key]));
  }
  return [];
}

import { RulePreviewPanel, isRenderablePreview } from '../RulePreviewPanel';
import type { RuleForm } from '../../types';

const MATCH_RULE: RuleForm = {
  tier: 'detection_match',
  about: { name: 'ssh-bruteforce', description: '', enabled: true, priority: 100 },
  predicates: [{ field: 'rule.id', op: 'equals', value: '5710' }],
  threshold: { groupBy: 'ip', n: 5, windowSeconds: 120, mode: 'threshold' },
};

const AUTOMATION_RULE: RuleForm = {
  tier: 'case_automation',
  about: { name: 'tagger', description: '', enabled: true, priority: 50 },
  automation: { conditions: {}, action: 'tag', payload: { tags: ['x'] } },
};

function renderPanel(rule: RuleForm = MATCH_RULE) {
  return render(
    <TooltipProvider>
      <RulePreviewPanel rule={rule} />
    </TooltipProvider>,
  );
}

describe('RulePreviewPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the preview through the READ-ONLY rules.preview path only (no LLM, no close)', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));

    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));

    // it sent the flat predicate + a bounded look-back window (7d default) to the RO endpoint
    const arg = previewSpy.mock.calls[0][0];
    expect(arg.match).toEqual([{ field: 'rule.id', op: 'equals', value: '5710' }]);
    expect(String(arg.from)).toMatch(/^now-7d$/);

    // The whole point: nothing but the read-only preview was called. No LLM path, no
    // what-if decision, no case action or job, no runbook run write.
    expect(calledSpies(apiModule)).toEqual(['api.rules.preview']);
    expect(calledSpies(runbookModule)).toEqual([]);
    // The spies cover the real surface (a spy per method, not a hand-kept list).
    expect(vi.isMockFunction(apiModule.api.caseActionExec)).toBe(true);
    expect(vi.isMockFunction(apiModule.api.jobs.submit)).toBe(true);
    expect(vi.isMockFunction(runbookModule.attachRunbook)).toBe(true);
    expect(vi.isMockFunction(runbookModule.updateRunbookStep)).toBe(true);
  });

  it('renders the match count + histogram from the pure result', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    // the "matched" summary word + the scanned total render from the pure result
    expect(screen.getByText('matched')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
    // the histogram is rendered as an accessible recharts image
    expect(screen.getByRole('img', { name: /match-count histogram/i })).toBeInTheDocument();
  });

  it('never offers a scan for a case-automation rule (no predicate to preview)', () => {
    renderPanel(AUTOMATION_RULE);
    expect(screen.getByText(/preview is for detection rules/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run preview/i })).not.toBeInTheDocument();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it('projects only the authoritative first predicate from a legacy multi-row draft', async () => {
    // Old local drafts may still carry extra rows. Normal authoring cannot create them,
    // and preview must match the single-predicate wire contract exactly.
    const MULTI: RuleForm = {
      ...MATCH_RULE,
      predicates: [
        { field: 'rule.id', op: 'equals', value: '5710' },
        { field: 'source.ip', op: 'equals', value: '10.0.0.1' },
        { field: 'user.name', op: 'equals', value: 'root' },
      ],
    };
    renderPanel(MULTI);
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await waitFor(() => expect(previewSpy).toHaveBeenCalledTimes(1));
    expect(previewSpy.mock.calls[0][0].match).toEqual([
      { field: 'rule.id', op: 'equals', value: '5710' },
    ]);
  });
  it('states the read-only guarantee in a help tip, not a permanent box (Round 14, D26)', async () => {
    const { container } = renderPanel();
    expect(container.querySelector('[role="alert"], [data-slot="alert"]')).toBeNull();
    expect(screen.queryByText(/never runs the AI/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About the preview' }));
    expect(await screen.findByText(/never runs the AI, never creates a case and never escalates/i)).toBeInTheDocument();
  });

  it('shows the result on one panel with a sentence-case label and no spinning refresh glyph', async () => {
    const { container } = renderPanel();
    const run = screen.getByRole('button', { name: /run preview/i });
    expect(run.querySelector('.lucide-refresh-cw')).toBeNull();
    fireEvent.click(run);
    const result = await screen.findByTestId('rule-preview-result');
    expect(result.className).toContain('surface-panel');
    expect(within(result).getByText('Matches over time')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/uppercase|tracking-wider/);
    expect(container.textContent ?? '').not.toContain('\u2014');
  });
  it('says what Run preview does before the first run, and drops that line once a result shows', async () => {
    renderPanel();
    expect(screen.getByTestId('rule-preview-idle')).toHaveTextContent(
      'Run a preview to count matches over the selected window.',
    );
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await screen.findByTestId('rule-preview-result');
    expect(screen.queryByTestId('rule-preview-idle')).toBeNull();
  });

  it('says the window had no events instead of a rate over zero events', async () => {
    previewSpy.mockResolvedValueOnce({
      scanned: 0,
      matched: 0,
      match_rate: 0,
      histogram: [],
      sample: [],
      predicates: 1,
      predicates_evaluated: 1,
      hard_capped: false,
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    const result = await screen.findByTestId('rule-preview-result');
    expect(within(result).getByTestId('rule-preview-no-events')).toHaveTextContent(
      'No events in this window to test against. Try a longer window.',
    );
    expect(result.textContent ?? '').not.toMatch(/match rate|events scanned|would not have fired/);
  });

  it('keeps the no-match sentence for a window that had events but no match', async () => {
    previewSpy.mockResolvedValueOnce({
      scanned: 250,
      matched: 0,
      match_rate: 0,
      histogram: [],
      sample: [],
      predicates: 1,
      predicates_evaluated: 1,
      hard_capped: false,
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    const result = await screen.findByTestId('rule-preview-result');
    expect(within(result).getByText('No matches in this window, so the rule would not have fired.')).toBeInTheDocument();
    expect(within(result).getByText('250')).toBeInTheDocument();
    expect(within(result).queryByTestId('rule-preview-no-events')).toBeNull();
  });

  it('reports an unreadable preview response as a failed preview instead of crashing', async () => {
    previewSpy.mockResolvedValueOnce({} as never);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    expect(await screen.findByText('Preview failed')).toBeInTheDocument();
    expect(screen.queryByTestId('rule-preview-result')).toBeNull();
  });
});

describe('isRenderablePreview', () => {
  it('accepts finite counts with a histogram list and rejects anything else', () => {
    expect(isRenderablePreview({ matched: 1, scanned: 2, match_rate: 0.5, histogram: [] })).toBe(true);
    expect(isRenderablePreview({ matched: 1, scanned: 2, match_rate: 0.5 })).toBe(true);
    expect(isRenderablePreview({})).toBe(false);
    expect(isRenderablePreview(null)).toBe(false);
    expect(isRenderablePreview({ matched: 'x', scanned: 2, match_rate: 0.5 })).toBe(false);
    expect(isRenderablePreview({ matched: 1, scanned: Number.NaN, match_rate: 0.5 })).toBe(false);
    expect(isRenderablePreview({ matched: 1, scanned: 2, match_rate: 0.5, histogram: 'no' })).toBe(false);
  });
});
