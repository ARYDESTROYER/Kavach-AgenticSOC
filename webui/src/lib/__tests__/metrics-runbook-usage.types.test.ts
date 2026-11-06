/**
 * `GET /api/metrics` carries `runbook_usage` (Round 14, SPEC §4.10.18; the server builds it
 * in `engine/metrics.py`), so the client `Metrics` type declares it and no page needs a
 * local intersection to read it. `playbook_usage` stays for one release, deprecated.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Metrics } from '../types';

const read = (...parts: string[]) => readFileSync(path.resolve(process.cwd(), ...parts), 'utf8');

describe('Metrics.runbook_usage', () => {
  it('is a declared field of the client type, keyed by runbook id', () => {
    expectTypeOf<Metrics['runbook_usage']>().toEqualTypeOf<Record<string, number>>();
    expectTypeOf<Metrics['playbook_usage']>().toEqualTypeOf<Record<string, number>>();
  });

  it('is what the server sends, and the type marks the retired field deprecated', () => {
    expect(read('..', 'backend', 'app', 'engine', 'metrics.py')).toMatch(/"runbook_usage":/);
    const types = read('src', 'lib', 'types.ts');
    const block = types.slice(types.indexOf('export interface Metrics {'));
    const beforeRetired = block.slice(0, block.indexOf('playbook_usage:'));
    const retiredDoc = beforeRetired.slice(beforeRetired.lastIndexOf('/**'));
    expect(retiredDoc).toContain('@deprecated');
    expect(retiredDoc).toContain('Read `runbook_usage`');
  });

  it('is read straight off the type on the Metrics page (no local intersection)', () => {
    const page = read('src', 'soc', 'pages', 'Metrics.tsx');
    expect(page).not.toMatch(/Metrics\s*&\s*\{\s*runbook_usage/);
    expect(page).not.toMatch(/MetricsPayload/);
    expect(page).toMatch(/data\?\.runbook_usage/);
  });
});
