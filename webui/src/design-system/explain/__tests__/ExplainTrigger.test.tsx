/**
 * The Explain kit (Round 16 SPEC §4.5 WP11; research explainability §5.1): the hover line
 * on hover and keyboard focus (WCAG 2.2 SC 1.4.13: Escape dismisses it), the full
 * arithmetic on click, Enter or a tap, focus back on the trigger when the panel closes,
 * "Copy calculation", a mouse-only row hover with no focusable content, and every value
 * rendered literally.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe, toHaveNoViolations } from 'jest-axe';

const h = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));
vi.mock('@/lib/clipboard', () => ({ copyText: h.copyText }));

import { ExplainTrigger, explainLinkHref } from '@/design-system/explain';
import type { Explanation } from '@/lib/explain/types';

expect.extend(toHaveNoViolations);

const EXPLANATION: Explanation = {
  metric: 'risk_score',
  title: 'Risk score',
  value: 81.11,
  display: 'Risk 81',
  summary: 'Risk 81.11 = (0.25 x 94.45 + 0.20 x 100 + 0.30 x 75 + 0.15 x 60 + 0.10 x 60) / 1.00. Click for inputs.',
  formula: 'sum(weight x factor) / sum(weights)',
  inputs: [{ key: 'rule_values', label: 'Rule types', value: '<img src=x onerror=alert(1)>', source: 'Recorded at scoring' }],
  steps: [{ label: 'Volume', expression: 'min(100, 100 x ln(1 + 40) / ln(1 + 50))', result: '94.45' }],
  rounding: 'Shown as 81 (rounded half up).',
  provenance: 'recorded',
  provenanceNote: 'Weights and inputs recorded when this case was scored.',
  caveats: ['The case now holds 50 events; the score was computed from the 40 events in its scoring run.'],
  link: { label: 'Open the case', route: 'case_manager', params: { caseId: 'case-1' } },
};

function renderTrigger(props: Partial<React.ComponentProps<typeof ExplainTrigger>> = {}) {
  return render(
    <div>
      <ExplainTrigger explanation={EXPLANATION} {...props}>
        <span>Risk 81</span>
      </ExplainTrigger>
      <button type="button">elsewhere</button>
    </div>,
  );
}

describe('ExplainTrigger (interactive)', () => {
  it('names itself by the value it shows, plus "explain"', () => {
    renderTrigger();
    expect(screen.getByRole('button', { name: /^Risk 81\s?, explain$/ })).toBeInTheDocument();
  });

  it('shows the one-line formula on keyboard focus, and Escape dismisses it', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.tab();
    const hover = await screen.findByTestId('explain-hover');
    expect(hover).toHaveTextContent(EXPLANATION.summary);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('explain-hover')).toBeNull());
  });

  it('shows the hover line on mouse hover', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.hover(screen.getByRole('button', { name: /Risk 81/ }));
    expect(await screen.findByTestId('explain-hover')).toHaveTextContent('Click for inputs.');
  });

  it('opens the full calculation on Enter and returns focus to the trigger when closed', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.tab();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Risk score' });
    expect(dialog).toHaveTextContent('min(100, 100 x ln(1 + 40) / ln(1 + 50))');
    expect(dialog).toHaveTextContent('Weights and inputs recorded when this case was scored.');
    expect(screen.queryByTestId('explain-hover')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /Risk 81/ })).toHaveFocus();
    // Closing the panel does not reopen the hover line while focus stays on the trigger.
    expect(screen.queryByTestId('explain-hover')).toBeNull();
  });

  it('a touch tap opens the panel without the hover card', async () => {
    renderTrigger();
    const trigger = screen.getByRole('button', { name: /Risk 81/ });
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    fireEvent.click(trigger);
    expect(await screen.findByTestId('explain-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('explain-hover')).toBeNull();
  });

  it('copies the calculation as text', async () => {
    const user = userEvent.setup();
    renderTrigger();
    await user.click(screen.getByRole('button', { name: /Risk 81/ }));
    await user.click(await screen.findByRole('button', { name: 'Copy calculation' }));
    await waitFor(() => expect(h.copyText).toHaveBeenCalledTimes(1));
    const text = (h.copyText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain('Risk score: Risk 81');
    expect(text).toContain('- Volume: min(100, 100 x ln(1 + 40) / ln(1 + 50)) = 94.45');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('renders hostile values literally (#9) and has no axe violations', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderTrigger();
    await user.click(screen.getByRole('button', { name: /Risk 81/ }));
    const panel = await screen.findByTestId('explain-panel');
    expect(panel).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(baseElement.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the case' })).toHaveAttribute('href', '#/case_manager?caseId=case-1');
    let results: Awaited<ReturnType<typeof axe>> | null = null;
    await act(async () => {
      results = await axe(baseElement);
    });
    expect(results).toHaveNoViolations();
  });

  it('tells the host when it opens, so data can load lazily', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderTrigger({ onOpenChange });
    await user.click(screen.getByRole('button', { name: /Risk 81/ }));
    await screen.findByTestId('explain-panel');
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('renders the children alone without an explanation', () => {
    render(
      <ExplainTrigger explanation={null}>
        <span>plain</span>
      </ExplainTrigger>,
    );
    expect(screen.getByText('plain')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ExplainTrigger (row-hover)', () => {
  it('adds no focusable control inside a row and shows the line on mouse hover only', async () => {
    const user = userEvent.setup();
    render(
      <button type="button" aria-label="CASE-1, Risk 81">
        <ExplainTrigger explanation={EXPLANATION} mode="row-hover">
          <span data-testid="row-risk">Risk 81</span>
        </ExplainTrigger>
      </button>,
    );
    // Only the row's own button is focusable; the trigger is the child span itself.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByTestId('row-risk').tagName).toBe('SPAN');
    await user.hover(screen.getByTestId('row-risk'));
    const hover = await screen.findByTestId('explain-hover');
    expect(hover).toHaveTextContent('Risk 81.11 = ');
    expect(hover).not.toHaveTextContent('Select it for the full calculation.');
    expect(hover.querySelectorAll('button, a, [tabindex]')).toHaveLength(0);
  });
});

describe('explainLinkHref', () => {
  it('builds a Console hash link', () => {
    expect(explainLinkHref({ label: 'x', route: 'cases', params: { status: 'open', q: 'a b' } })).toBe(
      '#/cases?status=open&q=a+b',
    );
  });
});
