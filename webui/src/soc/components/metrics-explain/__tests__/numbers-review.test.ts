/**
 * Round 16 numbers review (package XFNUM): dashboard explanations say what they count.
 *
 * * open-now-explanation-window-words: a stock measured now (the cases open now) never
 *   says it is limited to "the time range above" or "the cases in the window".
 * * dwell-definition-omits-person: the dwell clock is a person's first response; an
 *   automatic close is not counted.
 * * noise-detailed-headline-irreproducible: the Detailed "Reduced by" explanation prints
 *   its own numerator (Needs a human) and arithmetic that gives its printed result.
 */
import { describe, expect, it } from 'vitest';

import { explainShare } from '@/lib/explain/builders';
import { LIFECYCLE_METRICS } from '@/soc/pages/posture.format';

import {
  explainAlertReduction,
  explainAverageRisk,
  explainCount,
  explainKpiShare,
  wholePercentStep,
  explainNeverReachedPerson,
  explainSlaAtRisk,
  explainTeamAckMedian,
  SERVER_COUNTED,
  TIMING_DEFINITIONS,
} from '../builders';

describe('a stock measured now', () => {
  it('names its window source and provenance, never the window', () => {
    const exp = explainCount({
      metric: 'open_now',
      title: 'Open cases',
      value: 15,
      noun: 'open cases',
      window: 'Now, any arrival date',
      windowSource: 'Not limited by the time range above',
      provenanceNote: 'Counted by the server over every open case, whenever it arrived.',
      summary: '15 cases are open now, whenever they arrived.',
      formula: 'count of cases that are not resolved or closed, all time',
    })!;
    const window = exp.inputs.find((i) => i.key === 'window')!;
    expect(window.source).toBe('Not limited by the time range above');
    expect(exp.provenanceNote).toBe('Counted by the server over every open case, whenever it arrived.');
    expect(exp.provenanceNote).not.toContain('in the window');
  });

  it('a windowed count keeps the default wording', () => {
    const exp = explainCount({ metric: 'case_count', title: 'Cases', value: 3, noun: 'cases', window: 'the last 24 hours', summary: 's', formula: 'f' })!;
    expect(exp.inputs.find((i) => i.key === 'window')?.source).toBe('The time range above');
    expect(exp.provenanceNote).toBe(SERVER_COUNTED);
  });
});

describe('dwell is a person\'s first response', () => {
  it('says so in the explanation and the help', () => {
    expect(TIMING_DEFINITIONS.dwell).toContain('first response by a person');
    expect(TIMING_DEFINITIONS.dwell).toContain('Automatic closes are not counted');
    // A person who escalates first and acknowledges later stops dwell at the escalation
    // and time to acknowledge at the acknowledgement, with no close involved (backend
    // test_dwell_can_be_shorter_than_time_to_acknowledge_without_a_close), so no
    // equality with time to acknowledge is claimed.
    expect(TIMING_DEFINITIONS.dwell).not.toMatch(/equals time to acknowledge/);
    expect(TIMING_DEFINITIONS.dwell).toContain('dwell can be shorter than time to acknowledge');
    expect(LIFECYCLE_METRICS.dwell.help).toContain('first response by a person');
    expect(LIFECYCLE_METRICS.dwell.help).toContain('Automatic closes are not counted');
    expect(LIFECYCLE_METRICS.dwell.help).not.toContain('first active response');
  });
});

describe('the Detailed noise reduction headline', () => {
  it('prints 1 - needs human / ingested with the real counts', () => {
    const exp = explainNeverReachedPerson({ ingested: 167, needsHuman: 4, escalated: 7, shownPct: 97.6, window: 'the last 24 hours' })!;
    expect(exp.display).toBe('97.6%');
    expect(exp.summary).toBe('1 - 4 needed a human / 167 alerts ingested = 97.6%, the last 24 hours.');
    expect(exp.steps.map((s) => [s.expression, s.result])).toEqual([
      ['4 / 167', '0.024'],
      ['100 x (1 - 4 / 167)', '97.6%'],
    ]);
    // The printed arithmetic gives the printed result.
    expect(Math.round(1000 * (1 - 4 / 167)) / 10).toBe(97.6);
    expect(exp.caveats.join(' ')).toContain('Needs a human stage');
    expect(exp.caveats.join(' ')).toContain('Escalated (7) is a different stage');
  });

  it('says so when the counts give a different figure than the server', () => {
    const exp = explainNeverReachedPerson({ ingested: 1000, needsHuman: 5, shownPct: 96, window: 'the last 24 hours' })!;
    expect(exp.steps[1].result).toBe('99.5%');
    expect(exp.caveats[0]).toBe('These counts give 99.5%, not the 96% the server returned.');
  });

  it('is withheld without counts', () => {
    expect(explainNeverReachedPerson({ ingested: 0, needsHuman: 0, shownPct: 0, window: 'w' })).toBeNull();
    expect(explainNeverReachedPerson({ ingested: null, needsHuman: 3, shownPct: 0, window: 'w' })).toBeNull();
  });
});

/** A printed percent or number, and the same value worked out and rounded half up the way it is printed. */
function roundsTo(value: number, printed: string): boolean {
  const clean = printed.replace(/[,%]/g, '');
  const decimals = clean.includes('.') ? clean.split('.')[1].length : 0;
  const factor = 10 ** decimals;
  return Math.floor(value * factor + 0.5 + 1e-9) / factor === Number(clean);
}

describe('Alert reduction', () => {
  it('writes its reduction step from the counts, so the printed step gives its printed result', () => {
    // The seeded Demo's counts: 38 / 167 prints as 0.2275, and 1 - 0.2275 is 77.25%, which
    // rounds half up to 77.3%, not the 77.2% that 1 - 38 / 167 gives (review of XFNUM).
    const exp = explainAlertReduction(167, 38, 'the last 24 hours')!;
    const step = exp.steps.find((s) => s.label === 'Reduction')!;
    expect(step.expression).toBe('100 x (1 - 38 / 167)');
    expect(step.result).toBe('77.2%');
    expect(roundsTo(100 * (1 - 38 / 167), step.result)).toBe(true);
    expect(roundsTo(100 * (1 - 0.2275), step.result)).toBe(false);
    expect(exp.steps.find((s) => s.label === 'Ratio')).toEqual({ label: 'Ratio', expression: '38 / 167', result: '0.2275' });
  });

  it('ends on the whole percent the tile shows, with a step that gives it', () => {
    // 1 - 56 / 167 is 66.467%: one decimal prints 66.5%, whose rounding half up is 67,
    // while the tile shows 66% (the seeded Demo's 7-day Detection board).
    const exp = explainAlertReduction(167, 56, 'the last 7 days', '66%')!;
    const shown = exp.steps.find((s) => s.label === 'Shown')!;
    expect(shown).toEqual({ label: 'Shown', expression: 'floor(66.47 + 0.5)', result: '66%' });
    expect(Math.floor(66.47 + 0.5)).toBe(66);
    expect(exp.rounding).toBe('The tile shows a whole percent, rounded half up.');
    expect(exp.rounding).not.toContain('at most one decimal');
    // A whole percent that one decimal already gives keeps one decimal.
    expect(explainAlertReduction(167, 38, 'w', '77%')!.steps.at(-1)).toEqual({ label: 'Shown', expression: 'floor(77.2 + 0.5)', result: '77%' });
    // The bounded texts get a note, not a false step.
    const tiny = explainAlertReduction(1000, 998, 'w', '<1%')!;
    expect(tiny.steps.some((s) => s.label === 'Shown')).toBe(false);
    expect(tiny.caveats.join(' ')).toContain('<1%');
    // Without a tile the explanation stands alone.
    expect(explainAlertReduction(167, 56, 'w')!.steps.some((s) => s.label === 'Shown')).toBe(false);
  });
});

describe('a share and its tile', () => {
  it('writes the percent step from the counts (129 / 167 is 77.2%, while 0.7725 x 100 rounds to 77.3%)', () => {
    const exp = explainShare(129, 167)!;
    const percent = exp.steps.find((s) => s.label === 'Percent')!;
    expect(percent).toEqual({ label: 'Percent', expression: '129 / 167 x 100', result: '77.2%' });
    expect(roundsTo((129 / 167) * 100, percent.result)).toBe(true);
    expect(roundsTo(0.7725 * 100, percent.result)).toBe(false);
  });

  it('a tile that shows a whole percent gets a Shown step that gives it', () => {
    const exp = explainKpiShare({
      metric: 'containment_rate', title: 'Containment', numerator: 111, denominator: 167,
      numeratorLabel: 'resolved or closed cases', denominatorLabel: 'cases', window: 'the last 7 days',
      dividedBy: 'server', tileRounding: 'The tile shows a whole percent.', tileWholePercent: true,
    })!;
    // The result line and the summary end on the tile's figure (FXF), never on 66.5%.
    expect(exp.display).toBe('66%');
    expect(exp.summary).toBe('111 resolved or closed cases of 167 cases = 66.47%, shown as 66%, the last 7 days.');
    expect(exp.steps.at(-1)).toEqual({ label: 'Shown', expression: 'floor(66.47 + 0.5)', result: '66%' });
    expect(wholePercentStep(12.5)).toEqual({ label: 'Shown', expression: 'floor(12.5 + 0.5)', result: '13%' });
  });
});

describe('Average risk', () => {
  it('names the scored cases it divides by and the rounding the tile shows', () => {
    const exp = explainAverageRisk({ mean: 23.6, scoredCases: 77, population: 'all time' })!;
    expect(exp.display).toBe('24');
    // Only scored cases are in the mean, so never "every case" (review of XFNUM).
    expect(exp.summary).toBe('Mean risk 23.6 over 77 scored cases: the sum of their risk scores / 77, all time.');
    expect(exp.summary).not.toContain('every case');
    expect(exp.steps).toEqual([{ label: 'Shown', expression: 'floor(23.6 + 0.5)', result: '24' }]);
    expect(exp.inputs.find((i) => i.key === 'scored')?.value).toBe('77');
  });

  it('never says "all time" for the newest N cases', () => {
    const exp = explainAverageRisk({ mean: 30, scoredCases: 500, population: 'newest 500 of 1,204 cases' })!;
    expect(exp.summary).toContain('the newest 500 of 1,204 cases');
    expect(exp.summary).not.toContain('all time');
    expect(exp.caveats.join(' ')).toContain('older cases are not in the mean');
  });

  it('is withheld without a mean', () => {
    expect(explainAverageRisk({ mean: null, scoredCases: 0, population: 'all time' })).toBeNull();
  });
});

describe('the SLA at-risk sum', () => {
  it('adds the two clocks and says a case can count twice', () => {
    const exp = explainSlaAtRisk({ responseAtRisk: 2, resolveAtRisk: 1, window: 'the last 7 days' })!;
    expect(exp.display).toBe('3');
    expect(exp.steps[0]).toEqual({ label: 'Sum', expression: '2 + 1', result: '3' });
    expect(exp.caveats.join(' ')).toContain('counts twice');
  });
});

describe('Team activity median time to acknowledge', () => {
  it('names the cases and the middle rank', () => {
    const odd = explainTeamAckMedian({ medianSeconds: 130, samples: 9, shown: '2m 10s', window: 'last 7 days' })!;
    expect(odd.summary).toBe('Median 2m 10s over 9 cases a person first acknowledged, last 7 days.');
    expect(odd.steps[0].expression).toBe('the time at rank 5 of 9 sorted times');
    const even = explainTeamAckMedian({ medianSeconds: 130, samples: 4, shown: '2m 10s', window: 'last 7 days' })!;
    expect(even.steps[0].expression).toBe('the mean of the times at ranks 2 and 3 of 4 sorted times');
  });

  it('is withheld when not measured', () => {
    expect(explainTeamAckMedian({ medianSeconds: null, samples: 0, shown: '', window: 'w' })).toBeNull();
  });
});
