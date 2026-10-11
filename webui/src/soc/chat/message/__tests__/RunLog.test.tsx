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

  it('shows a parameter in both maps once (as untrusted text), with readable names and values', () => {
    render(
      <RunLogList
        id="log-3"
        steps={stepsFromResponse([
          step(1, {
            label: 'Searched logs',
            params: { ip: '203.0.113.93', time_from: 'now-7d', size: 5 },
            untrusted_params: { ip: '203.0.113.93' },
          }),
          step(2, {
            label: 'Searched cases',
            params: { sort_field: 'created_at', window_hours: 168, case_id: 'demo-1' },
            untrusted_params: { case_id: 'demo-1' },
          }),
        ])}
      />,
    );
    // Each value once, and that one is the untrusted (mono) chip.
    expect(screen.getAllByText('203.0.113.93')).toHaveLength(1);
    expect(screen.getByText('203.0.113.93')).toHaveClass('font-mono');
    expect(screen.getAllByText('demo-1')).toHaveLength(1);
    expect(screen.getAllByText('IP')).toHaveLength(1);
    expect(screen.getByText('Case')).toBeInTheDocument();
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getAllByText('last 7 days')).toHaveLength(2);
    expect(screen.getByText('Sorted by')).toBeInTheDocument();
    expect(screen.getByText('creation time')).toBeInTheDocument();
    expect(screen.queryByText('now-7d')).toBeNull();
    expect(screen.queryByText('created_at')).toBeNull();
  });

  it('says so when nothing has run yet', () => {
    render(<RunLogList id="log-2" steps={[]} />);
    expect(screen.getByText('No lookups yet.')).toBeInTheDocument();
  });
});

describe('RunLogList — Round 12', () => {
  it('appends the host’s quiet notes and draws model notes without a status word', () => {
    render(
      <RunLogList
        id="log-n"
        steps={[model(1, 'ok', 'Summarised earlier messages'), ...stepsFromResponse([step(2)]), model(3, 'running', 'Continued the answer (part 2)')]}
        notes={[{ key: 'n-repeat', text: 'Stopped repeating the same lookup', kind: 'repeat' }]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Lookups' });
    const notes = Array.from(list.querySelectorAll('[data-run-note]')).map((n) => [n.getAttribute('data-run-note'), n.textContent]);
    expect(notes).toEqual([
      ['compacted', 'Earlier messages were summarised to keep going'],
      ['continued', 'Continued the answer (part 2)'],
      ['repeat', 'Stopped repeating the same lookup'],
    ]);
    // The running continuation shows the shared glyph, never a status word.
    expect(within(list.querySelector('[data-run-note="continued"]') as HTMLElement).getByTestId('console-loading-glyph')).toBeInTheDocument();
    expect(list.querySelector('[data-run-note="continued"]')).not.toHaveTextContent('Running');
  });

  it('offers Inspect on settled lookups only and hands the opener to the host', () => {
    const calls: Array<[number, string | null]> = [];
    const running: RunLogStep = { ...stepsFromResponse([step(3)])[0], status: 'running', result: null };
    render(
      <RunLogList
        id="log-i"
        steps={[...stepsFromResponse([step(1), step(2, { status: 'error' })]), running, model(4, 'ok', 'Wrote the answer')]}
        onInspect={(s, opener) => calls.push([s.index, opener.getAttribute('aria-label')])}
      />,
    );
    const buttons = screen.getAllByTestId('run-log-inspect');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Inspect step 1: Searched logs', 'Inspect step 2: Searched logs']);
    fireEvent.click(buttons[1]);
    expect(calls).toEqual([[2, 'Inspect step 2: Searched logs']]);
  });

  it('offers no Inspect without a host handler (a live run log)', () => {
    render(<RunLogList id="log-x" steps={stepsFromResponse([step(1)])} />);
    expect(screen.queryByTestId('run-log-inspect')).toBeNull();
  });
});
