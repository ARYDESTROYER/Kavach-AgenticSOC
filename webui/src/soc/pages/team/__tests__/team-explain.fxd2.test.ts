/**
 * Round 16 FXD2: Team activity's median can be recomputed from the times it lists, and
 * People active says who was counted (a sign-in counts).
 */
import { describe, expect, it } from 'vitest';

import type { PersonActivity, TeamKind } from '@/lib/types-team';
import { explainPeopleActive, explainTeamMedian, type TeamTotalsWithTimes } from '../team-explain';

const ZERO: Record<TeamKind, number> = {
  acknowledged: 0, closed: 0, reopened: 0, escalated: 0, commented: 0, assigned: 0,
  screenshot_added: 0, reviewed: 0, runbook_step_done: 0, signed_in: 0,
};

const team = (extra: Partial<TeamTotalsWithTimes>): TeamTotalsWithTimes =>
  ({ people_active: 0, median_ack_seconds: 420, ack_samples: 2, ack_status: 'measured', ...extra }) as TeamTotalsWithTimes;

const person = (username: string, counts: Partial<Record<TeamKind, number>>, kind: PersonActivity['kind'] = 'account'): PersonActivity =>
  ({ key: username, username, display_name: '', role: '', active: true, kind, counts: { ...ZERO, ...counts } }) as unknown as PersonActivity;

describe('the team median lists its times', () => {
  it('two times: the mean of ranks 1 and 2 (the Demo panel)', () => {
    const e = explainTeamMedian(team({ ack_sample_seconds: [120, 720], ack_sample_offset: 0 }), '7m', 'today');
    expect(e?.inputs.find((i) => i.key === 'times')).toMatchObject({ label: 'The times, in order', value: '2m (120 s), 12m (720 s)' });
    expect(e?.steps).toEqual([
      { label: 'Median', expression: 'ranks 1 and 2 of 2: (120 + 720) / 2', result: '420 seconds, shown as 7m' },
    ]);
  });

  it('an odd count names the middle time', () => {
    const e = explainTeamMedian(team({ median_ack_seconds: 300, ack_samples: 3, ack_sample_seconds: [60, 300, 900] }), '5m', 'today');
    expect(e?.steps[0]).toEqual({ label: 'Median', expression: 'the time at rank 2 of 3: 300 seconds', result: '300 seconds, shown as 5m' });
  });

  it('a long list shows the times around the median with their ranks', () => {
    const run = Array.from({ length: 200 }, (_, i) => 100 + i);
    // 1,000 times; the run starts at rank 401 (offset 400); ranks 500 and 501 are 199 and 200.
    const e = explainTeamMedian(team({ median_ack_seconds: 199.5, ack_samples: 1000, ack_sample_seconds: run, ack_sample_offset: 400 }), '3m 20s', 'last 30 days');
    expect(e?.steps[0].expression).toBe('ranks 500 and 501 of 1,000: (199 + 200) / 2');
    expect(e?.steps[0].result).toBe('199.5 seconds, shown as 3m 20s');
    const times = e?.inputs.find((i) => i.key === 'times');
    expect(times?.label).toMatch(/^Times at ranks \d+ to \d+ of 1,000$/);
    expect(e?.caveats[0]).toBe('Showing 12 of 1,000 times, the ones around the median.');
  });

  it('without the times (an older backend) it keeps the rule only', () => {
    const e = explainTeamMedian(team({}), '7m', 'today');
    expect(e?.inputs.find((i) => i.key === 'times')).toBeUndefined();
    expect(e?.steps[0].expression).toBe('the mean of the times at ranks 1 and 2 of 2 sorted times');
  });
});

describe('People active names who was counted', () => {
  const PEOPLE = [
    person('Admin', { signed_in: 3 }),
    person('asha.iyer', {}, 'demo'),
    person('farhan.qureshi', { acknowledged: 1, commented: 1 }, 'demo'),
    person('meera.pillai', { acknowledged: 1, closed: 1 }, 'demo'),
    person('', { closed: 4 }, 'unattributed'),
  ];

  it('lists the three counted people, sign-ins included', () => {
    const e = explainPeopleActive(PEOPLE, 3, 'today');
    expect(e?.display).toBe('3');
    expect(e?.summary).toBe('3 people with at least one counted action, today; 1 of them only signed in.');
    expect(e?.inputs.slice(0, 3)).toEqual([
      { key: 'person_0', label: 'Admin', value: '3 counted actions', source: '3 sign-ins' },
      { key: 'person_1', label: 'farhan.qureshi', value: '2 counted actions', source: '1 acknowledged, 1 commented' },
      { key: 'person_2', label: 'meera.pillai', value: '2 counted actions', source: '1 acknowledged, 1 closed' },
    ]);
    expect(e?.caveats[0]).toMatch(/A sign-in counts as activity/);
  });

  it('makes no claim when the list does not give the server count', () => {
    expect(explainPeopleActive(PEOPLE, 4, 'today')).toBeNull();
  });
});
