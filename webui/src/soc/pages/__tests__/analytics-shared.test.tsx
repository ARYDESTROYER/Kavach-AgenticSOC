/**
 * The shared Analytics pieces (Round 14, SPEC §4.9): the time range and its session
 * memory, the in-app text link, a bar's share of the whole, the module sort switch, the
 * strip-in-a-panel grammar and the header freshness stamp. Plus a copy guard over the
 * Analytics and Standup sources: no dash punctuation and never the word "playbook".
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DASH } from '@/lib/format';
import { KpiTile } from '@/soc/components/KpiTile';
import {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_HOURS,
  RouteTextLink,
  SortToggle,
  StripPanel,
  UpdatedStamp,
  analyticsWindow,
  resetAnalyticsWindowForTests,
  shareOfTotal,
  tokenLabel,
  useAnalyticsWindow,
  windowCaption,
} from '../analytics-shared';

afterEach(() => {
  resetAnalyticsWindowForTests();
  vi.useRealTimers();
});

describe('tokenLabel', () => {
  it('reads an enum token as a sentence-case label that keeps its acronyms', () => {
    expect(tokenLabel('rag')).toBe('RAG');
    expect(tokenLabel('llm_router')).toBe('LLM router');
    expect(tokenLabel('report_summary')).toBe('Report summary');
    expect(tokenLabel('investigator')).toBe('Investigator');
    expect(tokenLabel('mitre')).toBe('MITRE');
  });

  it('reads an empty token as the dash', () => {
    expect(tokenLabel('')).toBe(DASH);
    expect(tokenLabel(null)).toBe(DASH);
    expect(tokenLabel(undefined)).toBe(DASH);
  });
});

describe('Analytics windows', () => {
  it('offers the last 24 hours, 7 days and 30 days, defaulting to 7 days', () => {
    expect(ANALYTICS_WINDOWS.map((w) => w.hours)).toEqual([24, 168, 720]);
    expect(DEFAULT_ANALYTICS_HOURS).toBe(168);
    expect(windowCaption(24)).toBe('last 24 hours');
    expect(windowCaption(720)).toBe('last 30 days');
  });

  it('falls back to the default window for hours that are not a preset', () => {
    expect(analyticsWindow(5).hours).toBe(168);
    expect(windowCaption(Number.NaN)).toBe('last 7 days');
  });

  it('remembers the picked range for the session, across unmounts', () => {
    const first = renderHook(() => useAnalyticsWindow());
    expect(first.result.current[0]).toBe(168);
    act(() => first.result.current[1](720));
    expect(first.result.current[0]).toBe(720);
    first.unmount();

    const second = renderHook(() => useAnalyticsWindow());
    expect(second.result.current[0]).toBe(720);
    // An unknown range is not remembered as such: it reads as the default.
    act(() => second.result.current[1](5));
    expect(second.result.current[0]).toBe(168);
  });
});

describe('shareOfTotal', () => {
  it('reads a part as its share of the whole, never of the largest part', () => {
    expect(shareOfTotal(39, 77)).toBe('51% of 77');
    expect(shareOfTotal(77, 77)).toBe('100% of 77');
    expect(shareOfTotal(0, 77)).toBe('0% of 77');
  });

  it('says "<1%" for a part that rounds to nothing, never 0%', () => {
    expect(shareOfTotal(1, 1000)).toBe('<1% of 1,000');
  });

  it('formats the whole with the caller formatter', () => {
    expect(shareOfTotal(1, 4, (n) => `$${n.toFixed(2)}`)).toBe('25% of $4.00');
  });

  it('has nothing to say about an empty or unusable whole', () => {
    expect(shareOfTotal(3, 0)).toBeUndefined();
    expect(shareOfTotal(3, Number.NaN)).toBeUndefined();
    expect(shareOfTotal(Number.NaN, 4)).toBeUndefined();
  });
});

describe('RouteTextLink', () => {
  it('is a real link whose plain click navigates in the app', () => {
    const navigate = vi.fn();
    render(
      <RouteTextLink page="cost" onNavigate={navigate}>
        Open Cost
      </RouteTextLink>,
    );
    const link = screen.getByRole('link', { name: 'Open Cost' });
    expect(link).toHaveAttribute('href', '#/cost');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('cost', undefined);
  });

  it('leaves a modified click to the browser (a new tab)', () => {
    const navigate = vi.fn();
    render(
      <RouteTextLink page="case_manager" opts={{ caseId: 'case-1' }} onNavigate={navigate} aria-label="Open CASE-1">
        CASE-1
      </RouteTextLink>,
    );
    const link = screen.getByRole('link', { name: 'Open CASE-1' });
    expect(link).toHaveAttribute('href', '#/case_manager?caseId=case-1');
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('SortToggle', () => {
  it('switches one module between Count and A to Z', async () => {
    const onChange = vi.fn();
    render(<SortToggle label="Sort persona usage" value="count" onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Sort persona usage' });
    expect(within(group).getByRole('radio', { name: 'Count' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(group).getByRole('radio', { name: 'A to Z' }));
    expect(onChange).toHaveBeenCalledWith('alpha');
  });
});

describe('StripPanel', () => {
  it('is one titled module whose figures sit on the panel, not in cards', () => {
    render(
      <StripPanel title="Triage quality" caption="last 7 days" data-testid="strip">
        <KpiTile label="FP rate" value="63%" />
        <KpiTile label="Escalation rate" value="12%" />
      </StripPanel>,
    );
    const panel = screen.getByTestId('strip');
    expect(within(panel).getByRole('heading', { name: 'Triage quality' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('last 7 days');
    expect(panel.querySelector('[data-strip-panel]')).not.toBeNull();
    expect(panel.querySelectorAll('[data-testid^="kpi-"]').length).toBeGreaterThanOrEqual(2);
  });
});

describe('UpdatedStamp', () => {
  it('says when the figures were read, with the exact time in the tooltip', () => {
    const at = new Date(Date.now() - 4 * 60_000).toISOString();
    render(<UpdatedStamp at={at} />);
    const stamp = screen.getByTestId('analytics-updated');
    expect(stamp).toHaveTextContent(/^Updated /);
    expect(stamp.getAttribute('title')).toBeTruthy();
  });

  it('renders nothing before the first read', () => {
    const { container } = render(<UpdatedStamp at={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Analytics and Standup copy', () => {
  const SRC = path.resolve(process.cwd(), 'src/soc');
  const FILES = [
    'pages/Analytics.tsx',
    'pages/Metrics.tsx',
    'pages/Cost.tsx',
    'pages/AgentEffectiveness.tsx',
    'pages/Standup.tsx',
    'pages/analytics-shared.tsx',
    'components/HealthDiagnostics.tsx',
  ];

  it('keeps the shared module inside the Analytics chunk (Standup does not import it)', () => {
    // A second lazy importer would split it into its own chunk, which costs the entry
    // bundle a preload-map entry (SPEC §3.4 budget).
    const importers = ['pages/Standup.tsx', 'pages/Home.tsx', 'pages/Overview.tsx'];
    for (const file of importers) {
      expect(readFileSync(path.join(SRC, file), 'utf8'), file).not.toMatch(/from\s+['"][^'"]*analytics-shared['"]/);
    }
  });

  it.each(FILES)('%s has no em or en dash and never says playbook', (file) => {
    const text = readFileSync(path.join(SRC, file), 'utf8');
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/playbook/i);
  });
});
