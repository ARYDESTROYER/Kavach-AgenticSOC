/**
 * Case Manager visual-dialect gates (Round 12, CM-8 acceptance):
 *   - no tracked capitals (`uppercase tracking-*`) anywhere in `casedetail/*`;
 *   - the IOC verdict is tri-state — "Clean" never renders, least of all when no
 *     provider answered (source unavailable / confidence 0);
 *   - AI-authored thread messages render Markdown safely (no raw `**`), human text stays
 *     plain (#9);
 *   - Timeline colour follows the VALUE (a Risk 7 case is never red) with no glow.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { Case, IocReputation, ThreatContextPanel as ThreatPanelData } from '@/lib/types';
import type { CaseMessage, TimelineStagesResponse } from '@/soc/pages/CaseDetail.api';
import { CaseThread } from '@/soc/components/CaseThread';
import { ThreatContextPanel, iocVerdict } from '../ThreatContextPanel';
import { StageTimeline } from '../StageTimeline';

const DIR = path.resolve(process.cwd(), 'src/soc/pages/casedetail');

describe('casedetail sentence case', () => {
  it('has no tracked capitals in any case panel', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(DIR)) {
      if (!/\.(tsx|ts)$/.test(name)) continue;
      const text = readFileSync(path.join(DIR, name), 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/\buppercase\b[^'"`]*\btracking-/.test(line) || /\btracking-[a-z]+\b[^'"`]*\buppercase\b/.test(line)) {
          offenders.push(`${name}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('IOC verdict is tri-state', () => {
  const ioc = (over: Partial<IocReputation>): IocReputation =>
    ({ indicator: '203.0.113.9', ...over }) as IocReputation;

  it('maps provider answers honestly', () => {
    expect(iocVerdict(ioc({ is_malicious: true, source: 'abuseipdb' })).label).toBe('Malicious');
    expect(iocVerdict(ioc({ is_malicious: false, source: 'abuseipdb', score: 0 })).label).toBe('No detections');
    expect(iocVerdict(ioc({ is_malicious: false, score: 0 })).label).toBe('Not checked');
    expect(iocVerdict(ioc({ is_malicious: false, sources: { note: 'cache miss' } })).label).toBe('Not checked');
    expect(iocVerdict(ioc({})).label).toBe('Not checked');
  });

  it('never renders "Clean" in either presentation', () => {
    const panel = {
      case_id: 'c1',
      summary: 'One indicator, no provider answered.',
      ioc_reputation: [ioc({ is_malicious: false, score: 0 })],
      mitre_techniques: [],
    } as unknown as ThreatPanelData;
    for (const presentation of ['default', 'case-manager'] as const) {
      const { unmount } = render(
        <ThreatContextPanel
          c={{ case_id: 'c1', verdict: 'NEEDS_HUMAN' } as Case}
          panel={panel}
          loading={false}
          error={null}
          onRetry={vi.fn()}
          presentation={presentation}
        />,
      );
      expect(screen.queryByText('Clean')).toBeNull();
      expect(screen.getByText('Not checked')).toBeInTheDocument();
      unmount();
    }
  });
});

describe('AI thread messages', () => {
  const base: CaseMessage = {
    id: 'm1',
    case_id: 'c1',
    parent_id: null,
    author_type: 'ai',
    author: 'assistant',
    body: 'The host is **clean** per `abuseipdb`.',
    mentions: [],
    reactions: [],
    kind: 'comment',
    created_at: '2026-10-09T10:00:00Z',
    edited_at: null,
    deleted_at: null,
    ai_meta: null,
  };
  const noop = { onPost: vi.fn(), onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onReact: vi.fn() };

  it('renders AI Markdown as formatting, never raw asterisks; human text stays literal', () => {
    render(
      <CaseThread
        messages={[base, { ...base, id: 'm2', author_type: 'human', author: 'jdoe', body: 'I typed **this** myself' }]}
        users={[]}
        currentUser="jdoe"
        canComment={false}
        {...noop}
      />,
    );
    const ai = screen.getByTestId('case-thread-ai-body');
    expect(ai.textContent).not.toContain('**');
    expect(ai.querySelector('strong')?.textContent).toBe('clean');
    expect(ai.querySelector('code')?.textContent).toBe('abuseipdb');
    expect(screen.getByText('I typed **this** myself')).toBeInTheDocument();
  });
});

describe('Timeline colour follows the value', () => {
  const data = (score: number): TimelineStagesResponse => ({
    case_id: 'c1',
    total: 1,
    stages: [
      {
        id: 'risk',
        kind: 'risk',
        label: 'Risk',
        ts: '2026-10-09T10:00:00Z',
        status: 'done',
        deterministic: true,
        headline: `Risk ${score}/100`,
        state: { risk_score: score },
        steps: [],
      },
    ],
  });

  it('a Risk 7 stage is low (not red) and nothing glows', () => {
    const { container } = render(<StageTimeline data={data(7)} presentation="case-manager" />);
    const marker = container.querySelector('[data-stage-marker="risk"]');
    expect(marker?.className).toContain('bg-low');
    expect(marker?.className).not.toContain('bg-critical');
    expect(container.innerHTML).not.toMatch(/shadow-glow|shadow-\[0_0_/);
    expect(container.querySelector('[data-risk-band]')?.getAttribute('data-risk-band')).toBe('low');
    // The score shows ONCE, as the meter (no duplicate chip).
    expect(screen.queryByText('risk 7/100')).toBeNull();
  });

  it('a Risk 90 stage is critical', () => {
    const { container } = render(<StageTimeline data={data(90)} presentation="case-manager" />);
    expect(container.querySelector('[data-stage-marker="risk"]')?.className).toContain('bg-critical');
  });
});
