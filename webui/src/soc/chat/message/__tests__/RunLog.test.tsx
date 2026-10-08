/**
 * RunLog — rows per tool call or parallel batch, model steps only while awaited or
 * failed (or the final "Wrote the answer"), status words (never colour alone), chips,
 * coverage, and the exact query as untrusted code behind its own disclosure.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { RunLogList, buildRunRows, stepsFromResponse, type RunLogStep } from '../RunLog';
import { step } from './fixtures';

const model = (index: number, status: RunLogStep['status'], label = 'Thinking'): RunLogStep => ({
  index,
  kind: 'model',
  tool: null,
  label,
  params: {},
  group: null,
  status,
  result: null,
});

describe('buildRunRows', () => {
  it('frames tool calls of one parallel batch as one row', () => {
    const steps = stepsFromResponse([step(1, { group: 1 }), step(2, { group: 1 }), step(3, { group: null }), step(4, { group: 2 })]);
    const rows = buildRunRows(steps);
    expect(rows.map((row) => (row.kind === 'group' ? `g${row.steps.length}` : `s${row.step.index}`))).toEqual(['g2', 's3', 's4']);
  });

  it('keeps only the awaited, failed or final model step', () => {
    const rows = buildRunRows([
      model(1, 'ok', 'Planned lookups'),
      ...stepsFromResponse([step(2)]),
      model(3, 'error', 'Model call failed'),
      model(4, 'running', 'Writing the answer'),
    ]);
    expect(rows.map((row) => (row.kind === 'step' ? row.step.label : 'group'))).toEqual([
      'Searched logs',
      'Model call failed',
      'Writing the answer',
    ]);
    const done = buildRunRows([...stepsFromResponse([step(1)]), model(2, 'ok', 'Wrote the answer')]);
    expect(done.map((row) => (row.kind === 'step' ? row.step.label : 'group'))).toEqual(['Searched logs', 'Wrote the answer']);
  });
});

describe('RunLogList', () => {
  it('renders status words, chips, summary and coverage, and the query on demand', () => {
    render(
      <RunLogList
        id="log-1"
        steps={stepsFromResponse([
          step(1, { status: 'timeout', untrusted_params: { indicator: 'evil.example' } }),
          step(2, { status: 'denied', label: 'Looked up an indicator', query: null, coverage: null, summary: 'indicator not from user or evidence', rows: null, basis: null }),
        ])}
      />,
    );
    expect(screen.getByText('Timed out · 1.2 s')).toBeInTheDocument();
    expect(screen.getByText('Denied · 1.2 s')).toBeInTheDocument();
    expect(screen.getAllByText('Window')[0]).toBeInTheDocument();
    expect(screen.getAllByText('last 24h')[0]).toBeInTheDocument();
    expect(screen.getByText('evil.example')).toHaveClass('font-mono');
    expect(screen.getByText(/1,284 matching events · newest 200 of 1,284/)).toBeInTheDocument();
    expect(screen.getByText('indicator not from user or evidence')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Query' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(within(region).getByText('event.outcome:failure AND source.ip:10.0.0.5')).toBeInTheDocument();
    expect(within(region).getByText(/untrusted text/)).toBeInTheDocument();
  });

  it('says so when nothing has run yet', () => {
    render(<RunLogList id="log-2" steps={[]} />);
    expect(screen.getByText('No lookups yet.')).toBeInTheDocument();
  });
});
