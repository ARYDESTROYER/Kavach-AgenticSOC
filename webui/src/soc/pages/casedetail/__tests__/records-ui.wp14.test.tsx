/**
 * Round 16 (SPEC §4.5 WP14): stored case data shown back where it belongs.
 *
 * * History (data-visibility R6): the reason a status move recorded, the resolution
 *   note, and the events attached later.
 * * Gradings (R8): the three quality scores, the AI verdict that was graded and the
 *   review origin.
 * * Threat context (R7): each provider of an indicator, how they were fused, errors and
 *   the raw excerpt fenced; "Checked when you opened this case" beside the reputation the
 *   investigation used.
 * * The Why panel (R15): the case's lifetime retrieval markers in words.
 *
 * Every value a person, a model or a provider wrote renders as text.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { Case, CaseFeedback, ThreatContextPanel as ThreatContextPanelData } from '@/lib/types';
import { CaseHistory, caseHistoryItems } from '../CaseHistory';
import { GradingHistory, gradedVerdictWords, qualityWords } from '../grading';
import { ThreatContextPanel, fusionLine, iocProviders, unfenced } from '../ThreatContextPanel';
import { lifetimeRetrievalLine } from '../WhyPanel';

expect.extend(toHaveNoViolations);

const HOSTILE = '<img src=x onerror=alert(1)>';
const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00Z`;

describe('history shows what people wrote', () => {
  const c = {
    case_id: 'c1',
    history: [
      { event: 'analyst_action', ts: at(1), action: 'hold', analyst: 'mira', note: '' },
      { event: 'attach', ts: at(2), added_events: 12 },
      { event: 'analyst_action', ts: at(3), action: 'resolve', analyst: 'dev', note: 'Done.', resolution: `Patched ${HOSTILE}` },
      { event: 'analyst_action', ts: at(4), action: 'deescalate', analyst: 'mira', note: 'Same words' },
      { event: 'attach', ts: at(5), added_events: 1 },
    ],
    status_history: [
      { from_status: 'investigating', to_status: 'on_hold', by: 'mira', at: at(1), reason: `Waiting for the vendor ${HOSTILE}` },
      { from_status: 'on_hold', to_status: 'resolved', by: 'dev', at: at(3), reason: 'Done.' },
      { from_status: 'escalated', to_status: 'investigating', by: 'mira', at: at(4), reason: 'Same words' },
    ],
  } as unknown as Case;

  it('pairs each action with the reason its status move recorded, once', () => {
    const items = caseHistoryItems(c);
    expect(items.map((item) => item.title)).toEqual([
      '1 new event attached',
      'De-escalated',
      'Resolved',
      '12 new events attached',
      'Put on hold',
    ]);
    expect(items[4].reason).toBe(`Waiting for the vendor ${HOSTILE}`);
    // The route stores the note as the reason when none was given: shown once, as the note.
    expect(items[2].reason).toBe('');
    expect(items[1].reason).toBe('');
    expect(items[2].resolution).toBe(`Patched ${HOSTILE}`);
    expect(items[0]).toMatchObject({ actor: 'system', who: 'Ingest' });
  });

  it('renders the reason and the resolution as text', () => {
    render(<CaseHistory c={c} />);
    expect(screen.getAllByTestId('case-history-reason')[0]).toHaveTextContent(`Reason: Waiting for the vendor ${HOSTILE}`);
    expect(screen.getByTestId('case-history-resolution')).toHaveTextContent(`Resolution: Patched ${HOSTILE}`);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('the full grading record', () => {
  const grade: CaseFeedback = {
    ts: at(9),
    analyst: 'mira',
    assessment: 'agree',
    accuracy: 0.8,
    reasoning_quality: 0.6,
    action_appropriateness: 0,
    ai_verdict: 'FALSE_POSITIVE',
    ai_confidence: 0.92,
    origin: 'auto_close_review',
    review_id: 'r1',
    comment: HOSTILE,
  };

  it('words the scores, the graded verdict and the origin', () => {
    expect(qualityWords(0.8)).toBe('80%');
    expect(qualityWords(0)).toBe('Not rated');
    expect(gradedVerdictWords(grade)).toBe('False positive at 92%');
    expect(gradedVerdictWords({ ...grade, ai_verdict: '' })).toBeNull();
  });

  it('opens the record of each grade', () => {
    render(<GradingHistory feedback={[grade]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full record' }));
    const record = screen.getByTestId('grading-record');
    expect(record).toHaveTextContent('Accuracy80%');
    expect(record).toHaveTextContent('Reasoning quality60%');
    expect(record).toHaveTextContent('Action appropriatenessNot rated');
    expect(record).toHaveTextContent('Graded the AI verdictFalse positive at 92%');
    expect(record).toHaveTextContent('From the auto-close review');
    expect(screen.getByText(HOSTILE)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says nothing about a review for an ordinary grade', () => {
    render(<GradingHistory feedback={[{ ...grade, origin: '' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full record' }));
    expect(screen.getByTestId('grading-record')).not.toHaveTextContent('auto-close review');
  });
});

const fence = (provider: string, text: string) =>
  `<<<UNTRUSTED_LOG_DATA>>> source=enrichment tool=${provider}\n${text}\n<<<END_UNTRUSTED_LOG_DATA>>>`;

describe('indicator providers', () => {
  const panel = {
    case_id: 'c1',
    ioc_reputation: [
      {
        indicator: '203.0.113.9',
        type: 'ip',
        score: 87,
        is_malicious: true,
        sources: { abuseipdb: 87, greynoise: 20 },
        method: 'max',
        providers_status: 'checked',
        errors: { shodan: fence('shodan', 'rate limited') },
        providers: [
          {
            provider: 'abuseipdb',
            score: 87,
            malicious: true,
            confidence: 0.9,
            tags: [fence('abuseipdb', HOSTILE)],
            raw: { usage: fence('abuseipdb', 'Data Center') },
            ok: true,
            error: null,
            cached: false,
          },
          { provider: 'greynoise', score: 20, malicious: false, confidence: null, tags: [], raw: {}, ok: true, error: null, cached: true },
          { provider: 'shodan', score: null, malicious: null, confidence: null, tags: [], raw: {}, ok: false, error: fence('shodan', 'rate limited'), cached: false },
        ],
      },
    ],
  } as unknown as ThreatContextPanelData;
  const c = {
    case_id: 'c1',
    risk_breakdown: { total: 40, inputs: { reputation_input: 0, reputation_source: 'enrichment' } },
  } as unknown as Case;

  it('reads the providers and words the fusion', () => {
    const { providers, method } = iocProviders(panel.ioc_reputation![0]);
    expect(providers.map((p) => p.provider)).toEqual(['abuseipdb', 'greynoise', 'shodan']);
    expect(fusionLine(method, 87, providers)).toBe('Fused by the highest score: 87 from abuseipdb.');
    expect(fusionLine('weighted', 62.4, providers)).toBe('Fused by a confidence-weighted average: 62.');
    expect(unfenced(fence('x', 'inner text'))).toBe('inner text');
    expect(unfenced('plain')).toBe('plain');
  });

  it('opens one line per provider, with errors, cache marks and the raw excerpt fenced', async () => {
    const { container } = render(<ThreatContextPanel c={c} panel={panel} loading={false} error={null} onRetry={() => undefined} />);
    expect(screen.getByTestId('threat-ioc-when')).toHaveTextContent('Checked when you opened this case. At investigation: 0.');
    fireEvent.click(screen.getByRole('button', { name: 'Providers for 203.0.113.9' }));
    const popover = await screen.findByRole('dialog', { name: 'Providers for 203.0.113.9' });
    const lines = within(popover).getAllByTestId('ioc-provider');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent('abuseipdbscore 87, malicious, confidence 90%');
    expect(lines[0]).toHaveTextContent(`Tags: ${HOSTILE}`);
    expect(within(lines[0]).getByText('untrusted provider response')).toBeInTheDocument();
    expect(lines[1]).toHaveTextContent('from the cache');
    expect(lines[2]).toHaveTextContent('did not answer');
    expect(lines[2]).toHaveTextContent('Error: rate limited');
    expect(within(popover).getByText('Fused by the highest score: 87 from abuseipdb.')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('never says "checked" when no provider was asked', () => {
    const skipped = {
      ioc_reputation: [{ indicator: '198.51.100.7', type: 'ip', score: 0, is_malicious: false, providers_status: 'skipped', providers: [] }],
    } as unknown as ThreatContextPanelData;
    render(<ThreatContextPanel c={c} panel={skipped} loading={false} error={null} onRetry={() => undefined} />);
    expect(screen.getByTestId('threat-ioc-when')).toHaveTextContent(
      'No provider was asked when you opened this case. At investigation: 0.',
    );
  });

  it('says when no provider result was recorded', async () => {
    const bare = { ioc_reputation: [{ indicator: 'evil.example', type: 'domain', score: 10, is_malicious: false, providers_status: 'not_recorded' }] } as unknown as ThreatContextPanelData;
    render(<ThreatContextPanel c={{ case_id: 'c1' } as Case} panel={bare} loading={false} error={null} onRetry={() => undefined} />);
    expect(screen.getByTestId('threat-ioc-when')).toHaveTextContent('Checked when you opened this case.');
    expect(screen.getByTestId('threat-ioc-when')).not.toHaveTextContent('At investigation');
    fireEvent.click(screen.getByRole('button', { name: 'Providers for evil.example' }));
    const popover = await screen.findByRole('dialog');
    expect(popover).toHaveTextContent('A cached answer, kept without its provider results.');
    expect(popover).toHaveTextContent('No provider results were recorded for this indicator.');
  });
});

describe('lifetime retrieval markers', () => {
  it('words both markers, either one, or neither', () => {
    expect(lifetimeRetrievalLine({ retrieval_history_status: 'available', retrieval_observation_status: 'measured' })).toBe(
      'Across this case: its full retrieval history is recorded, and at least one retrieval completed.',
    );
    expect(lifetimeRetrievalLine({ retrieval_history_status: 'unavailable', retrieval_observation_status: 'not_measured' })).toBe(
      'Across this case: its earlier retrieval history was not recorded, and no retrieval has completed yet.',
    );
    expect(lifetimeRetrievalLine({ retrieval_observation_status: 'unavailable' })).toBe(
      'Across this case: whether a retrieval completed was not recorded.',
    );
    expect(lifetimeRetrievalLine({})).toBeNull();
  });
});
