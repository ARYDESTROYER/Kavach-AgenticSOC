/**
 * RunLog — rows per tool call or parallel batch, model steps only while awaited or
 * failed (or the final "Wrote the answer"), status words (never colour alone), chips,
 * coverage, and the exact query as untrusted code behind its own disclosure.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import type { ChatLiveTurn } from '../../turn-runner';
import { RunLogHeader, RunLogList, buildRunRows, stepParamChips, stepsFromResponse, type RunLogStep } from '../RunLog';
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
    // The status word only when a lookup did not simply finish; the time after the label.
    const words = screen.getAllByTestId('run-log-status').map((node) => node.textContent);
    expect(words).toEqual(['Timed out', 'Denied']);
    expect(screen.getAllByTestId('run-log-duration').map((node) => node.textContent)).toEqual(['· 1.2 s', '· 1.2 s']);
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

  it("keeps a step's chips in one order while it runs and once it ends", () => {
    // Round 13 polish: an ended step listed its plain chips first and its untrusted ones
    // last, so the chips changed places the moment the lookup finished.
    const chipNames = () =>
      screen.getAllByTestId('run-log-chips').map((row) => Array.from(row.children, (chip) => chip.firstElementChild?.textContent));
    const running = (index: number, label: string, tool: string, params: RunLogStep['params']): RunLogStep => ({
      index,
      kind: 'tool',
      tool,
      label,
      params,
      group: null,
      status: 'running',
      result: null,
    });
    const indicator = { indicator: '203.0.113.77', kind: 'ip' };
    const logs = { ip: '203.0.113.77', time_from: 'now-7d' };
    const { rerender } = render(
      <RunLogList
        id="log-order"
        steps={[running(1, 'Looking up an indicator', 'lookup_indicator', indicator), running(2, 'Searching logs', 'search_logs', logs)]}
      />,
    );
    const whileRunning = chipNames();
    expect(whileRunning).toEqual([
      ['Indicator', 'Kind'],
      ['IP', 'From'],
    ]);
    rerender(
      <RunLogList
        id="log-order"
        steps={stepsFromResponse([
          step(1, { label: 'Looked up an indicator', tool: 'lookup_indicator', params: indicator, untrusted_params: { indicator: '203.0.113.77' }, sources: [] }),
          step(2, { label: 'Searched logs', params: logs, untrusted_params: { ip: '203.0.113.77' }, sources: [] }),
        ])}
      />,
    );
    expect(chipNames()).toEqual(whileRunning);
    // Ended, the untrusted values are mono, each shown once.
    for (const value of screen.getAllByText('203.0.113.77')) expect(value).toHaveClass('font-mono');
    expect(screen.getAllByText('203.0.113.77')).toHaveLength(2);
  });

  it('appends keys only the result or only the untrusted map names, after the started order', () => {
    expect(
      stepParamChips({
        params: { b: 1, a: 2 },
        result: step(1, { params: { a: 2, c: 3, b: 1 }, untrusted_params: { d: 'x', b: '1' } }),
      }).map((chip) => `${chip.key}${chip.untrusted ? '*' : ''}`),
    ).toEqual(['b*', 'a', 'c', 'd*']);
  });

  it('says what the assistant is doing before any lookup ran, never "No lookups yet."', () => {
    const { rerender } = render(<RunLogList id="log-2" steps={[]} />);
    expect(screen.getByTestId('run-log-pending')).toHaveTextContent('Reading your question…');
    expect(screen.queryByText('No lookups yet.')).toBeNull();
    const thinking: RunLogStep = {
      index: 1, kind: 'model', tool: null, label: 'Thinking', params: {}, group: null, status: 'running', result: null,
    };
    rerender(<RunLogList id="log-2" steps={[thinking]} />);
    expect(screen.getByTestId('run-log-pending')).toHaveTextContent('Choosing lookups…');
    expect(screen.queryByText('Thinking')).toBeNull();
    // A model call that writes the answer straight away keeps its own row.
    rerender(<RunLogList id="log-2" steps={[{ ...thinking, label: 'Writing the answer' }]} />);
    expect(screen.queryByTestId('run-log-pending')).toBeNull();
    expect(screen.getByText('Writing the answer')).toBeInTheDocument();
  });

  it('lays a row out as icon, label, then the muted time; Done is the icon with an sr-only word', () => {
    render(<RunLogList id="log-d" steps={stepsFromResponse([step(1)])} />);
    const row = document.querySelector('[data-step-status="ok"]') as HTMLElement;
    const line = row.children[1].firstElementChild as HTMLElement;
    const parts = Array.from(line.children).map((node) => node.textContent);
    expect(parts.slice(0, 3)).toEqual(['Searched logs', 'Done', '· 1.2 s']);
    expect(within(row).getByText('Done')).toHaveClass('sr-only');
    expect(screen.queryByTestId('run-log-status')).toBeNull();
    // The status icon leads, at 16 px.
    expect(row.firstElementChild).toHaveClass('size-4');
  });

  it('reads verdicts, statuses and kinds in the console words, and many sources as a count', () => {
    render(
      <RunLogList
        id="log-w"
        steps={stepsFromResponse([
          step(1, {
            params: { verdict: 'TRUE_POSITIVE', status: 'escalated', kind: 'ip' },
            untrusted_params: {},
            sources: ['Wazuh Manager', 'Splunk Enterprise Security', 'Elastic'],
          }),
        ])}
      />,
    );
    expect(screen.getByText('True positive')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    expect(screen.getByText('IP')).toBeInTheDocument();
    expect(screen.queryByText('TRUE_POSITIVE')).toBeNull();
    const sources = screen.getByText('3 sources');
    expect(sources).toHaveAttribute('title', 'Wazuh Manager, Splunk Enterprise Security, Elastic');
  });

  it('names many sources "3 sources" (never "Source 3 sources") and shows the names on keyboard or touch', () => {
    render(
      <RunLogList
        id="log-s"
        steps={stepsFromResponse([step(1, { params: {}, untrusted_params: {}, sources: ['Wazuh Manager', 'Elastic', 'Splunk'] })])}
      />,
    );
    const chip = screen.getByRole('button', { name: '3 sources' });
    expect(chip).toHaveTextContent(/^3 sources$/);
    expect(screen.getByTestId('run-log-chips')).not.toHaveTextContent(/Source 3/);
    // The names are a disclosure, not only a pointer tooltip.
    const names = screen.getByTestId('run-log-source-names');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).toHaveAttribute('aria-controls', names.id);
    expect(names).not.toBeVisible();
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(names).toBeVisible();
    expect(names).toHaveTextContent('Wazuh Manager, Elastic, Splunk');
  });

  it('gives each lookup’s source names their own id, so a button never controls another lookup’s list (review RV1)', () => {
    render(
      <RunLogList
        id="log-1"
        steps={stepsFromResponse([
          step(1, { params: {}, untrusted_params: {}, sources: ['Wazuh', 'Elastic', 'Splunk'] }),
          step(2, { params: {}, untrusted_params: {}, sources: ['Okta', 'Entra ID'], group: 7 }),
          step(3, { params: {}, untrusted_params: {}, sources: ['Okta', 'Wazuh'], group: 7 }),
        ])}
      />,
    );
    const buttons = screen.getAllByTestId('run-log-sources');
    expect(buttons).toHaveLength(3);
    const ids = buttons.map((button) => button.getAttribute('aria-controls') as string);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    // Every id in the log is unique (the query disclosures and the list itself included).
    const all = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    expect(new Set(all).size).toBe(all.length);
    // Opening the second lookup's names opens its own list, and only that one.
    fireEvent.click(buttons[1]);
    const second = document.getElementById(ids[1]) as HTMLElement;
    expect(second).toBeVisible();
    expect(second).toHaveTextContent('Okta, Entra ID');
    expect(document.getElementById(ids[0])).not.toBeVisible();
    expect(document.getElementById(ids[2])).not.toBeVisible();
    fireEvent.click(buttons[0]);
    expect(document.getElementById(ids[0])).toHaveTextContent('Wazuh, Elastic, Splunk');
    expect(document.getElementById(ids[0])).toBeVisible();
  });

  it('keeps one source a plain "Source" chip', () => {
    render(<RunLogList id="log-1" steps={stepsFromResponse([step(1, { params: {}, untrusted_params: {}, sources: ['Wazuh'] })])} />);
    expect(screen.queryByTestId('run-log-sources')).toBeNull();
    expect(screen.getByTestId('run-log-chips')).toHaveTextContent(/^SourceWazuh$/);
  });
});

describe('RunLogHeader — narrow rows (T20, review F4/F14)', () => {
  const live = (over: Partial<ChatLiveTurn> = {}): ChatLiveTurn =>
    ({
      transport: 'stream',
      turnId: 't1',
      model: null,
      streamMode: 'live',
      replayed: false,
      estimatePromptTokens: 0,
      steps: [
        { index: 1, kind: 'tool', tool: 'search_cases', label: 'Searched cases', status: 'ok', params: {} },
        { index: 2, kind: 'tool', tool: 'case_stats', label: 'Counted cases', status: 'ok', params: {} },
        { index: 3, kind: 'tool', tool: 'soc_metrics', label: 'Read SOC metrics', status: 'ok', params: {} },
        { index: 4, kind: 'tool', tool: 'log_stats', label: 'Counted log events', status: 'running', params: {} },
      ],
      usage: { prompt_tokens: 9000, completion_tokens: 500, total_tokens: 9500, cost: 0.0312, estimated: true, simulated: true },
      text: 'x'.repeat(4000),
      stopping: false,
      connection: 'open',
      startedAt: 0,
      ...over,
    }) as unknown as ChatLiveTurn;

  it('wraps the row instead of squeezing the progress, and never splits a figure from its unit', () => {
    render(<RunLogHeader live={live()} open={false} onToggle={() => undefined} controls="log" />);
    const row = screen.getByTestId('run-log-header-row');
    expect(row).toHaveClass('flex-wrap');
    const usage = screen.getByTestId('run-log-usage');
    // The usage may drop under the progress: it neither refuses to shrink nor refuses to wrap.
    expect(usage.className).not.toMatch(/\bshrink-0\b|\bwhitespace-nowrap\b/);
    const usageGroups = Array.from(usage.querySelectorAll('[data-figure-group]')).map((el) => el.textContent);
    expect(usageGroups).toEqual(['≈ 9.5k tokens', '· ≈ $0.03', '· simulated', '· ≈ 1k output tokens']);
    const progress = screen.getByTestId('run-log-progress-label');
    expect(Array.from(progress.querySelectorAll('[data-figure-group]')).map((el) => el.textContent)).toEqual(['· 4 lookups']);
    for (const group of Array.from(row.querySelectorAll('[data-figure-group]'))) expect(group).toHaveClass('whitespace-nowrap');
    expect(screen.getByTestId('run-log-header')).toHaveTextContent('Working · 4 lookups');
    expect(usage).toHaveTextContent('≈ 9.5k tokens · ≈ $0.03 · simulated · ≈ 1k output tokens');
  });

  it('lets the state sentence wrap between its words while each count stays whole (review RV2)', () => {
    // "Connection lost. Checking whether the answer was saved" is wider than a phone's
    // header row: held on one line it ran past the row and under the chevron.
    render(<RunLogHeader live={live({ connection: 'recovering' })} open={false} onToggle={() => undefined} controls="log" />);
    const progress = screen.getByTestId('run-log-progress-label');
    const state = progress.querySelector('[data-run-state]') as HTMLElement;
    expect(state).toHaveTextContent(/^Connection lost\. Checking whether the answer was saved$/);
    expect(state).not.toHaveClass('whitespace-nowrap');
    expect(state.closest('.whitespace-nowrap')).toBeNull();
    expect(state).not.toHaveAttribute('data-figure-group');
    const count = within(progress).getByText('· 4 lookups');
    expect(count).toHaveClass('whitespace-nowrap');
    expect(count).toHaveAttribute('data-figure-group');
    // The label may shrink inside the button, which may shrink inside the wrapping row.
    expect(progress).toHaveClass('min-w-0');
    expect(screen.getByTestId('run-log-header')).toHaveClass('min-w-0');
    expect(screen.getByTestId('run-log-header')).toHaveTextContent('Connection lost. Checking whether the answer was saved · 4 lookups');
  });

  it('keeps every state sentence out of the unbreakable figure groups', () => {
    for (const [over, text] of [
      [{ stopping: true }, 'Stopping after the current step'],
      [{ waiting: true }, 'Waiting for another answer to finish'],
      [{}, 'Working'],
    ] as const) {
      const { unmount } = render(<RunLogHeader live={live(over as Partial<ChatLiveTurn>)} open={false} onToggle={() => undefined} controls="log" />);
      const state = screen.getByTestId('run-log-progress-label').querySelector('[data-run-state]') as HTMLElement;
      expect(state).toHaveTextContent(text);
      expect(state.closest('.whitespace-nowrap')).toBeNull();
      unmount();
    }
  });

  it('draws no count group before the first lookup', () => {
    render(<RunLogHeader live={live({ steps: [] })} open={false} onToggle={() => undefined} controls="log" />);
    const progress = screen.getByTestId('run-log-progress-label');
    expect(progress).toHaveTextContent(/^Working$/);
    expect(progress.querySelectorAll('[data-figure-group]')).toHaveLength(0);
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
