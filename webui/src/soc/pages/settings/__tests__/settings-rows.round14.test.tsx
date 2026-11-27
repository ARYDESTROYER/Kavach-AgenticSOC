/**
 * Settings rows (Round 14, SPEC §4.9.6 and §3.3): two layout rules every section keeps.
 *
 * 1. Dimming happens in one place. A control that a switch above it turns off is disabled
 *    and dims itself (Switch, NumberField, Select and TagInput each carry their own
 *    disabled style). Nothing wraps rows, group titles, captions or help in an extra
 *    `opacity-*` layer: that stacked a second dim on the switches (about 36%) and took
 *    explanatory text below WCAG AA (review findings on Runbooks, Knowledge, Detection,
 *    SLA and Remember me).
 * 2. A row's control column is never narrower than the number field in it. A field sizes
 *    itself to its digits, unit and steppers (`NumberField` `xs` 6rem, `sm` 8rem, `md`
 *    12rem); a narrower `controlWidth` squeezed "180 days" on Runbooks to "18".
 *
 * Geometry is never asserted here (jsdom has no layout); these are the structural rules
 * that make the measured result right, checked on every section that has such rows.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSources: vi.fn().mockResolvedValue({ sources: [] }),
      setup: { status: vi.fn().mockResolvedValue({}) },
    },
  };
});

import type { Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { SessionPolicyEditor } from '@/soc/components/SessionPolicyEditor';

import { RunbooksSection } from '../runbooks';
import { KnowledgeSection } from '../knowledge';
import { DetectionSection } from '../detection';
import { CasePolicySection } from '../case-policy';
import { StandupSection } from '../standup';
import { AdvancedSection } from '../advanced';
import { DiscountedInferenceSection } from '../discounted-inference';
import { ChatAgentSection } from '../chat-agent';

const update = vi.fn();
const wrap = (node: React.ReactNode) => render(<TooltipProvider>{node}</TooltipProvider>);

/** Every rendered section, each in a state with its dependent controls turned off. */
const CASES: Array<[string, () => ReturnType<typeof render>]> = [
  ['Runbooks (off)', () => wrap(<RunbooksSection prefs={{ runbooks: { enabled: false } } as unknown as Preferences} update={update} />)],
  [
    'Knowledge (retrieval off)',
    () => wrap(<KnowledgeSection prefs={{ rag: { enabled: false } } as unknown as Preferences} update={update} onNavigate={vi.fn()} />),
  ],
  [
    'Detection (auto-close and cross-source off)',
    () =>
      wrap(
        <DetectionSection
          prefs={
            {
              auto_close: { false_positive: { enabled: false }, true_positive: { enabled: false } },
              cross_source_correlation: { enabled: false },
            } as unknown as Preferences
          }
          update={update}
        />,
      ),
  ],
  ['SLA (tracking off)', () => wrap(<CasePolicySection prefs={{ sla: { enabled: false } } as unknown as Preferences} update={update} />)],
  ['Standup', () => wrap(<StandupSection prefs={{ standup: { window_hours: 24, interval_seconds: 86400 } } as unknown as Preferences} update={update} />)],
  ['Advanced', () => wrap(<AdvancedSection prefs={{ caps: {} } as unknown as Preferences} update={update} />)],
  ['Discounted inference (read-only)', () => wrap(<DiscountedInferenceSection prefs={{} as Preferences} update={update} readOnly />)],
  ['Chat assistant', () => wrap(<ChatAgentSection prefs={{} as Preferences} update={update} />)],
  [
    'Chat assistant (Bounded)',
    () =>
      wrap(
        <ChatAgentSection
          prefs={{ chat_agent: { limits_mode: 'bounded', chat_daily_cap_usd: 5 } } as unknown as Preferences}
          update={update}
        />,
      ),
  ],
  [
    'Session policy (Remember me off)',
    () =>
      wrap(
        <SessionPolicyEditor
          policy={{ remember_me: { enabled: false, idle_seconds: 3600 } }}
          onChange={vi.fn()}
          embedded
        />,
      ),
  ],
];

/** Elements that dim themselves and everything in them (`opacity-60`, not `disabled:opacity-50`). */
function dimmed(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('*')].filter((el) =>
    /(^|\s)opacity-\d+(\s|$)/.test(typeof el.className === 'string' ? el.className : ''),
  );
}

const SIZE_PX: Record<string, number> = { xs: 96, sm: 128, md: 192 };

describe('Settings rows: one dimming layer', () => {
  it.each(CASES)('%s: no opacity layer over rows, titles, captions or help', (_name, mount) => {
    const { container } = mount();
    for (const el of dimmed(container)) {
      // Only a control's own box may dim (a disabled NumberField); it holds no text of a row.
      expect(el.querySelector('h3, p, label, [data-setting-row], [data-settings-group]')).toBeNull();
      expect(el.matches('[data-setting-row], [data-settings-group], h3, p, label')).toBe(false);
    }
  });
});

describe('Settings rows: the control column fits its number field', () => {
  it.each(CASES)('%s: no row is narrower than its number field', (_name, mount) => {
    const { container } = mount();
    for (const row of container.querySelectorAll<HTMLElement>('[data-setting-row="field"]')) {
      const column = row.style.getPropertyValue('--setting-control-w');
      if (!column) continue; // the default 16rem column fits every size
      expect(column).toMatch(/^\d+(\.\d+)?rem$/);
      const columnPx = parseFloat(column) * 16;
      for (const field of row.querySelectorAll<HTMLElement>('[data-number-field]')) {
        const size = field.getAttribute('data-number-field') as string;
        if (size === 'full') continue;
        expect(SIZE_PX[size], `a ${size} field in a ${column} column`).toBeLessThanOrEqual(columnPx);
      }
    }
  });

  it('gives the Bounded chat limits the 12rem column their token fields need, one edge for the group', () => {
    const { getByTestId, getByLabelText } = wrap(
      <ChatAgentSection prefs={{ chat_agent: { limits_mode: 'bounded' } } as unknown as Preferences} update={update} />,
    );
    // A 7-digit token count with its unit needs a 12rem field (130px is more than 8rem).
    for (const label of ['Token ceiling', 'Answer reserve', 'Answer length', 'Results per step']) {
      const row = getByLabelText(label).closest('[data-setting-row="field"]') as HTMLElement;
      expect(row.style.getPropertyValue('--setting-control-w'), label).toBe('12rem');
      expect(getByLabelText(label).closest('[data-number-field]'), label).toHaveAttribute('data-number-field', 'md');
    }
    const columns = new Set(
      [...getByTestId('chat-bounded-limits').querySelectorAll<HTMLElement>('[data-setting-row="field"]')].map((row) =>
        row.style.getPropertyValue('--setting-control-w'),
      ),
    );
    expect([...columns]).toEqual(['12rem']);
  });

  it('gives Runbooks "Review new runbooks every" its own 12rem field, never an 8rem column', () => {
    const { getByLabelText } = wrap(<RunbooksSection prefs={{} as Preferences} update={update} />);
    const input = getByLabelText('Review new runbooks every');
    const row = input.closest('[data-setting-row="field"]') as HTMLElement;
    expect(row.style.getPropertyValue('--setting-control-w')).toBe('');
    expect(input.closest('[data-number-field]')).toHaveAttribute('data-number-field', 'md');
  });
});
