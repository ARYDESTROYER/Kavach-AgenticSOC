/**
 * The case header's meta strip gives the status words priority (Round 16 WP16): on a short
 * line the owner's name gives way first (down to its disk), then the verdict chip's words,
 * and the status words or the outcome only once both are at their minimum.
 *
 * jsdom does no layout, so this pins the flex contract that decides who shrinks; the seeded
 * Demo check measures it at 1440 by 900 and 390 by 844.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), caseAssign: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import type { Case } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';

import { CaseHeaderMeta } from '../CaseHeaderMeta';

const LONG_OWNER = 'maximilian.alexander-worthington@soc.example.org';

function renderMeta(over: Partial<Case> = {}) {
  const c = {
    case_id: 'case-prio',
    case_number: 'CASE-0042',
    status: 'needs_human',
    verdict: 'NEEDS_HUMAN',
    confidence: 0.91,
    risk_score: 74,
    assignee: LONG_OWNER,
    ...over,
  } as unknown as Case;
  return render(
    <TooltipProvider>
      <CaseHeaderMeta
        c={c}
        outcome={caseOutcome(c)}
        users={[]}
        canAssign={false}
        onCaseChange={vi.fn()}
        ownerOpen={false}
        onOwnerOpenChange={vi.fn()}
      />
    </TooltipProvider>,
  );
}

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/** The element's flex-shrink weight, read from its Tailwind classes (1 for `shrink`). */
function shrinkWeight(el: Element | null): number {
  const classes = classesOf(el);
  if (classes.includes('shrink-0')) return 0;
  const custom = classes.map((c) => /^shrink-\[(\d+(?:\.\d+)?)\]$/.exec(c)?.[1]).find(Boolean);
  if (custom) return Number(custom);
  return 1; // `shrink`, or the flex default
}

describe('the case header meta strip gives the status words priority', () => {
  it('shrinks the owner name first, then the verdict, then the status words, a million times apart', () => {
    renderMeta();
    const owner = shrinkWeight(screen.getByTestId('case-detail-owner'));
    const verdict = shrinkWeight(document.querySelector('[data-meta-item="verdict"]'));
    const status = shrinkWeight(screen.getByTestId('case-detail-status'));
    expect(status).toBeGreaterThanOrEqual(1); // no weight under 1 (CSS Flexbox 9.7)
    expect(verdict).toBeGreaterThanOrEqual(status * 1e6);
    expect(owner).toBeGreaterThanOrEqual(verdict * 1e6);
    expect(screen.getByTestId('case-detail-status')).toHaveTextContent('Open · awaiting analyst');
  });

  it('lets only the words truncate, and keeps the owner disk and the confidence whole', () => {
    renderMeta();
    expect(classesOf(screen.getByTestId('case-detail-owner'))).toContain('min-w-5');
    expect(classesOf(screen.getByTestId('case-detail-owner-name'))).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    const chip = screen.getByTestId('case-ai-verdict');
    expect(classesOf(within(chip).getByText('Needs human review'))).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
    expect(classesOf(within(chip).getByText('91%'))).not.toContain('truncate');
    const words = within(screen.getByTestId('case-detail-status')).getByText('Open · awaiting analyst');
    expect(classesOf(words)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });

  it('gives the outcome of an ended case the same last place', () => {
    renderMeta({ status: 'closed', disposition: 'false_positive', decision_by: 'analyst' } as Partial<Case>);
    const outcome = document.querySelector('[data-meta-item="outcome"]');
    expect(outcome).not.toBeNull();
    const owner = shrinkWeight(screen.getByTestId('case-detail-owner'));
    expect(shrinkWeight(outcome)).toBeGreaterThanOrEqual(1);
    expect(owner).toBeGreaterThanOrEqual(shrinkWeight(outcome) * 1e12);
  });
});
