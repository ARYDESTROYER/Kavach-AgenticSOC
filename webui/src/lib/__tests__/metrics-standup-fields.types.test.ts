/**
 * Two fields the server sends that the client types now declare (Round 16):
 * `GET /api/metrics` carries `avg_risk_case_count`, the count Average risk divides by
 * (`engine/metrics.py`), and `GET /api/standup` carries `cost`, the summary's AI spend,
 * which reads `null` without `cost:view` (`api/routes.py`). No page reads either through
 * a local intersection.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Metrics, StandupResponse } from '../types';

const read = (...parts: string[]) => readFileSync(path.resolve(process.cwd(), ...parts), 'utf8');

function declaredIn(types: string, iface: string): string {
  const start = types.indexOf(`export interface ${iface} {`);
  expect(start, `${iface} is declared`).toBeGreaterThanOrEqual(0);
  return types.slice(start, types.indexOf('\n}\n', start));
}

describe('Metrics.avg_risk_case_count and StandupResponse.cost', () => {
  it('are declared fields of the client types', () => {
    expectTypeOf<Metrics['avg_risk_case_count']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<StandupResponse['cost']>().toEqualTypeOf<number | null | undefined>();
    const types = read('src', 'lib', 'types.ts');
    expect(declaredIn(types, 'Metrics')).toMatch(/\n {2}avg_risk_case_count\?: number;/);
    expect(declaredIn(types, 'StandupResponse')).toMatch(/\n {2}cost\?: number \| null;/);
  });

  it('are what the server sends', () => {
    expect(read('..', 'backend', 'app', 'engine', 'metrics.py')).toMatch(/"avg_risk_case_count":/);
    expect(read('..', 'backend', 'app', 'api', 'routes.py')).toMatch(/result\["cost"\] = None/);
  });

  it('is read straight off the type on the Metrics page (no local intersection)', () => {
    const page = read('src', 'soc', 'pages', 'Metrics.tsx');
    expect(page).not.toMatch(/Metrics\s*&\s*\{\s*avg_risk_case_count/);
    expect(page).toMatch(/data\.avg_risk_case_count/);
  });
});
