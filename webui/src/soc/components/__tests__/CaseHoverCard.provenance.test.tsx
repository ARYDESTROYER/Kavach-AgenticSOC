/**
 * CaseHoverCard — provenance + auto-closed adoption (Round-7 #12, W2.d).
 *
 * The hover preview must tell the SAME provenance story as the Cases list / CaseDetail:
 *   - a SEVERITY chip carries a per-case ProvenanceTag (SIEM-asserted vs code-derived),
 *   - a self-hiding "Auto-closed by AI" badge appears only when the AI auto-closed it.
 *
 * Radix HoverCard portals its content and only mounts it when OPEN, so we mock the
 * primitive to render the content unconditionally (same approach as
 * `ui-glitch-fixes.test.tsx`). This file is intentionally separate from
 * `CaseHoverCard.test.tsx`, which exercises the REAL Radix `asChild` trigger
 * focusability and must not be mocked.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@radix-ui/react-hover-card', () => {
  const Content = React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) =>
    React.createElement('div', { ref }, props.children as React.ReactNode),
  );
  Content.displayName = 'HoverCardContent';
  // CaseHoverCard holds a ref on its trigger (it closes the card when the trigger is
  // activated), so the stand-in must accept one like the real Radix Trigger does.
  const Trigger = React.forwardRef<HTMLElement, { children?: React.ReactNode }>(({ children }, _ref) =>
    React.createElement(React.Fragment, null, children),
  );
  Trigger.displayName = 'HoverCardTrigger';
  return {
    Root: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Trigger,
    Portal: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Content,
  };
});

import { CaseHoverCard } from '../CaseHoverCard';
import type { Case } from '@/lib/types';

function mk(overrides: Partial<Case>): Case {
  return { case_id: 'c1', status: 'open', title: 'A case', ...overrides } as unknown as Case;
}

describe('CaseHoverCard provenance + auto-closed (#12)', () => {
  it('shows a SIEM ProvenanceTag beside the severity chip when the source graded severity', () => {
    render(
      <CaseHoverCard case={mk({ severity_band: 'high', severity_source: 'source_asserted', risk_score: 60 })}>
        <span>trigger</span>
      </CaseHoverCard>,
    );
    // The severity chip renders its band label...
    expect(screen.getByText('High')).toBeInTheDocument();
    // ...and its provenance flips to `source` (SIEM-asserted).
    const tag = document.querySelector('[data-provenance="source"]');
    expect(tag).not.toBeNull();
    expect(tag).toHaveAttribute('aria-label', expect.stringMatching(/SIEM-asserted/i));
  });

  it('falls back to a code (derived) ProvenanceTag when severity is derived from risk', () => {
    render(
      <CaseHoverCard case={mk({ risk_score: 30 })}>
        <span>trigger</span>
      </CaseHoverCard>,
    );
    // No explicit severity_band/severity_source → derived from risk_score → `code`.
    expect(document.querySelector('[data-provenance="code"]')).not.toBeNull();
    expect(document.querySelector('[data-provenance="source"]')).toBeNull();
  });

  it('renders "Auto-closed by AI" only when the AI auto-closed the case', () => {
    render(
      <CaseHoverCard case={mk({ status: 'closed', decision_by: 'agent' })}>
        <span>trigger</span>
      </CaseHoverCard>,
    );
    expect(screen.getByText('Auto-closed by AI')).toBeInTheDocument();
  });

  it('hides the auto-closed badge for an analyst-closed / open case', () => {
    const { rerender } = render(
      <CaseHoverCard case={mk({ status: 'closed', decision_by: 'analyst' })}>
        <span>trigger</span>
      </CaseHoverCard>,
    );
    expect(screen.queryByText('Auto-closed by AI')).toBeNull();

    rerender(
      <CaseHoverCard case={mk({ status: 'open', decision_by: 'agent' })}>
        <span>trigger</span>
      </CaseHoverCard>,
    );
    expect(screen.queryByText('Auto-closed by AI')).toBeNull();
  });
});

describe('CaseHoverCard outcome (Round 12, D15)', () => {
  it('a NEEDS_HUMAN case closed as false positive previews the analyst outcome, AI verdict secondary', () => {
    render(
      <CaseHoverCard
        case={mk({
          status: 'closed',
          verdict: 'NEEDS_HUMAN',
          confidence: 0.75,
          decision_by: 'analyst',
          disposition: 'false_positive',
          history: [
            { event: 'analyst_action', action: 'close', analyst: 'aryan', classified_disposition: 'false_positive' },
          ],
        } as unknown as Partial<Case>)}
      >
        <span>trigger</span>
      </CaseHoverCard>,
    );
    expect(screen.getByTestId('case-hover-outcome')).toHaveTextContent('Closed as false positive');
    expect(screen.getByTestId('case-outcome')).toHaveAttribute('data-outcome-source', 'analyst');
    expect(document.querySelector('[data-provenance="analyst"]')).not.toBeNull();
    expect(screen.getByTestId('case-ai-verdict')).toHaveTextContent(/needs human review/i);
    expect(screen.queryByText(/^Undetermined$/)).toBeNull();
  });
});
