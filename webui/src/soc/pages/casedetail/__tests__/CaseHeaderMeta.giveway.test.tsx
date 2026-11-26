/**
 * The case header meta strip never keeps a control in a box of no size, and a long case
 * number ends in a middle ellipsis (XFUI3).
 *
 * Live, in the seeded Demo, the AI verdict item shrank to 0px near the 36rem pane edge
 * while an AI run showed (and beside a long case number), and its explain trigger stayed
 * in the tab order. A 40-character operator case number never shrank, so the strip scrolled
 * and cut the owner disk. jsdom does no layout and evaluates no container query, so this
 * pins the flex contract that decides every box's least width; the seeded Demo check
 * measures the strip at forced pane widths (see the XFUI3 Journal entry).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { InvestigationView } from '@/lib/types';

const h = vi.hoisted(() => ({ run: null as InvestigationView | null }));

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(() => Promise.resolve({})), caseAssign: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('@/soc/investigations/useAiRun', () => ({
  useAiRun: (caseId: string | null | undefined) => (caseId && h.run?.case_id === caseId ? h.run : null),
  useAiRunFinished: () => null,
  useAiRunCount: () => 0,
}));

import type { Case, SlaPolicy } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { caseOutcome } from '@/soc/components/outcome';

import {
  CaseHeaderMeta,
  META_CASE_NUMBER,
  META_RUN_ROOM,
  META_SHRINK,
  splitCaseNumber,
} from '../CaseHeaderMeta';

const LONG_NUMBER = 'CASE-crowdstrike-falcon-prod-2026-000041';

const POLICY = {
  enabled: true,
  business_hours_only: false,
  targets: { P3: { response_minutes: 120, resolve_minutes: 1440 } },
} as unknown as SlaPolicy;

function renderMeta(over: Partial<Case> = {}, opts: { review?: boolean; sla?: boolean } = {}) {
  const c = {
    case_id: 'case-giveway',
    case_number: 'CASE-000046',
    status: 'needs_human',
    verdict: 'NEEDS_HUMAN',
    confidence: 0.91,
    risk_score: 74,
    severity_band: 'critical',
    assignee: 'maximilian.alexander-worthington@soc.example.org',
    priority_level: 'P3',
    created_at: new Date(Date.now() - 26 * 60_000).toISOString(),
    ...over,
  } as unknown as Case;
  return render(
    <TooltipProvider>
      <CaseHeaderMeta
        c={c}
        outcome={caseOutcome(c)}
        users={[]}
        canAssign
        currentUser="probe"
        slaPolicy={opts.sla ? POLICY : null}
        onCaseChange={vi.fn()}
        ownerOpen={false}
        onOwnerOpenChange={vi.fn()}
        onStartReview={opts.review ? vi.fn() : undefined}
      />
    </TooltipProvider>,
  );
}

function running(): InvestigationView {
  return {
    run_id: 'run-1',
    case_id: 'case-giveway',
    state: 'running',
    trigger: 'manual',
    phase: 'investigating',
    started_at: new Date(Date.now() - 42_000).toISOString(),
  } as unknown as InvestigationView;
}

afterEach(() => {
  cleanup();
  h.run = null;
});

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/** A class that sets a least width above zero (`min-w-5`, `min-w-[calc(9ch+1.375rem+1px)]`). */
function hasFloor(el: Element): boolean {
  return classesOf(el).some((c) => {
    const step = /^min-w-(\d+(?:\.\d+)?)$/.exec(c);
    if (step) return Number(step[1]) > 0;
    const arbitrary = /^min-w-\[(.+)\]$/.exec(c);
    return Boolean(arbitrary && !/^0(?:px|rem)?$/.test(arbitrary[1]));
  });
}

/** Never shrinks below its content (a content box of its own, never capped). */
function neverShrinks(el: Element): boolean {
  const classes = classesOf(el);
  return classes.includes('shrink-0') && !classes.some((c) => c.startsWith('max-w-') && c !== 'max-w-full');
}

/** Its parent's only child that takes room (screen-reader-only text takes none). */
function onlyChildInFlow(el: Element): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  return Array.from(parent.children).filter((s) => !classesOf(s).includes('sr-only')).length === 1;
}

/**
 * Whether flex layout can never squeeze `el` to no width inside the strip: it never
 * shrinks, it has a floor, its parent never shrinks (so it lays `el` out at its own
 * width), or it is its parent's only child in flow and the parent keeps a box. A strip
 * item (a child of the strip) needs a floor or no shrink of its own.
 */
function keepsABox(el: Element, strip: Element): boolean {
  if (neverShrinks(el) || hasFloor(el)) return true;
  const parent = el.parentElement;
  if (!parent || parent === strip) return false;
  if (neverShrinks(parent)) return true;
  return onlyChildInFlow(el) && keepsABox(parent, strip);
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function expectNoControlCanVanish(label: string) {
  const strip = screen.getByTestId('case-detail-meta');
  const controls = Array.from(strip.querySelectorAll(FOCUSABLE));
  expect(controls.length, label).toBeGreaterThan(0);
  for (const control of controls) {
    const name = control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName;
    expect(keepsABox(control, strip), `${label}: "${name}" can shrink to a box of no size`).toBe(true);
  }
}

describe('no control in the meta strip can shrink to a box of no size (XFUI3)', () => {
  it('holds for an open case with a long owner name and an SLA', () => {
    renderMeta({}, { sla: true });
    expectNoControlCanVanish('open case');
  });

  it('holds while an AI run is under way (where the verdict reached 0px live)', () => {
    h.run = running();
    renderMeta();
    expect(screen.getByTestId('ai-run-chip')).toBeInTheDocument();
    expectNoControlCanVanish('AI run under way');
  });

  it('holds beside a long case number, and for an ended case with a review waiting', () => {
    renderMeta({ case_number: LONG_NUMBER });
    expectNoControlCanVanish('long case number');
    cleanup();
    renderMeta({ status: 'closed', decision_by: 'agent', verdict: 'FALSE_POSITIVE' } as Partial<Case>, { review: true });
    expectNoControlCanVanish('auto-closed case with a review waiting');
  });

  it('gives the verdict a floor, and hides it below 40rem, where it no longer fits', () => {
    // Measured in the seeded Demo: beside "Critical severity" and "Open · awaiting analyst"
    // the verdict sat at its floor from 36rem to 39rem, and kept 108px at 40rem.
    renderMeta();
    const verdict = document.querySelector('[data-meta-item="verdict"]');
    expect(classesOf(verdict)).toEqual(expect.arrayContaining(['min-w-20', 'hidden', '@[40rem]/case:inline-flex']));
    expect(classesOf(verdict)).not.toContain('min-w-0');
    expect(classesOf(verdict)).not.toContain('@[36rem]/case:inline-flex');
  });

  it('hides the whole verdict below a 48rem pane while the AI run chip shows', () => {
    // Beside the run chip the verdict sat at its floor up to 47rem, and kept 89px at 48rem.
    h.run = running();
    renderMeta();
    expect(classesOf(document.querySelector('[data-meta-item="verdict"]'))).toEqual(
      expect.arrayContaining([
        'group-has-[[data-meta-item=ai-run]]/meta:hidden',
        '@[48rem]/case:group-has-[[data-meta-item=ai-run]]/meta:inline-flex',
      ]),
    );
  });

  it('writes every run-room class out whole, so Tailwind generates it', () => {
    // Tailwind finds class names by scanning the source text; one put together in a
    // template string is never generated, and the rule would silently not apply.
    const source = readFileSync(resolve(__dirname, '../CaseHeaderMeta.tsx'), 'utf8');
    for (const value of Object.values(META_RUN_ROOM)) {
      for (const cls of value.split(/\s+/)) {
        expect(source.includes(`'${cls}`) || source.includes(` ${cls}`), cls).toBe(true);
      }
    }
    expect(source).not.toMatch(/`\$\{WITH_RUN_CHIP\}/);
  });
});

describe('a long case number ends in a middle ellipsis (XFUI3)', () => {
  it('keeps its end whole, lets its start truncate, and reads its whole value', () => {
    renderMeta({ case_number: LONG_NUMBER });
    const id = screen.getByTestId('case-detail-id');
    // Its whole value on hover and for assistive technology.
    expect(id).toHaveAttribute('title', LONG_NUMBER);
    const spoken = Array.from(id.querySelectorAll('.sr-only')).map((el) => el.textContent);
    expect(spoken).toEqual([LONG_NUMBER]);
    // The split on screen is hidden from assistive technology: the start truncates, the
    // last six characters never shrink.
    const visual = id.querySelector('[aria-hidden="true"]');
    expect(visual).not.toBeNull();
    const [head, tail] = Array.from(visual!.children);
    expect(head).toHaveTextContent(/^CASE-crowdstrike-falcon-prod-2026-$/);
    expect(classesOf(head)).toEqual(expect.arrayContaining(['truncate', 'min-w-[3ch]']));
    expect(tail).toHaveTextContent(/^000041$/);
    expect(classesOf(tail)).toContain('shrink-0');
    // Every box between the start and the item may shrink, so the item's floor is exact.
    expect(classesOf(visual)).toContain('min-w-0');
    expect(classesOf(id)).toContain('min-w-0');
  });

  it('is the anchor: it shrinks to a floor, never away, and is capped at 20 characters', () => {
    renderMeta({ case_number: LONG_NUMBER });
    const item = screen.getByTestId('case-detail-id').parentElement!;
    expect(item).toHaveAttribute('data-meta-item', 'case-number');
    const classes = classesOf(item);
    expect(classes).not.toContain('shrink-0');
    expect(classes).not.toContain('hidden');
    // The floor: two characters and the ellipsis, the last six, the copy control and its gap.
    expect(classes).toEqual(
      expect.arrayContaining(['font-mono', 'min-w-[calc(9ch+1.375rem+1px)]', 'max-w-[calc(20ch+1.375rem+1px)]']),
    );
    expect(META_CASE_NUMBER.headFloorChars + META_CASE_NUMBER.tailChars).toBe(9);
    // The copy control keeps its size and still copies the whole value.
    expect(classesOf(screen.getByRole('button', { name: 'Copy case ID' }))).toContain('shrink-0');
  });

  it('gives way after the verdict words and before the status words, a million times apart', () => {
    renderMeta({ case_number: LONG_NUMBER });
    const weight = (el: Element | null) => {
      const custom = classesOf(el).map((c) => /^shrink-\[(\d+)\]$/.exec(c)?.[1]).find(Boolean);
      return custom ? Number(custom) : 1;
    };
    const owner = weight(screen.getByTestId('case-detail-owner'));
    const verdict = weight(document.querySelector('[data-meta-item="verdict"]'));
    const number = weight(document.querySelector('[data-meta-item="case-number"]'));
    const status = weight(screen.getByTestId('case-detail-status'));
    expect(owner).toBeGreaterThanOrEqual(verdict * 1e6);
    expect(verdict).toBeGreaterThanOrEqual(number * 1e6);
    expect(number).toBeGreaterThanOrEqual(status * 1e6);
    expect(status).toBe(1);
    expect(META_SHRINK.caseNumber).toBe('shrink-[1000000]');
  });

  it('leaves a number of nine characters or fewer whole, never shrinking', () => {
    renderMeta({ case_number: 'TLSOC-001' });
    const id = screen.getByTestId('case-detail-id');
    expect(id).toHaveTextContent(/^TLSOC-001$/);
    expect(id.parentElement).toHaveClass('shrink-0');
    expect(id.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(splitCaseNumber('CASE-0042')).toBeNull();
    expect(splitCaseNumber('CASE-00042')).toEqual({ head: 'CASE', tail: '-00042' });
  });

  it('ellipsises the internal id of a case without a number the same way', () => {
    const caseId = 'case-6b22d0f3-41c8-4c2a-9e55-a1c9f070b4e2';
    renderMeta({ case_id: caseId, case_number: '' });
    const id = screen.getByTestId('case-detail-id');
    expect(id).toHaveAttribute('title', caseId);
    expect(id.querySelector('.sr-only')).toHaveTextContent(caseId);
    expect(splitCaseNumber(caseId)?.tail).toBe('70b4e2');
  });

  it('never splits inside a character outside the basic plane', () => {
    // Six characters from the end is the lock sign, two UTF-16 units: it is kept whole.
    expect(splitCaseNumber('CASE-1-\u{1F512}00041')).toEqual({ head: 'CASE-1-', tail: '\u{1F512}00041' });
  });
});
