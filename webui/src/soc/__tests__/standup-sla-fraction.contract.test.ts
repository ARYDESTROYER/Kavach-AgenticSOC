/**
 * The Standup's at-risk share agrees with the server. Since the server Standup reads the
 * one per-case SLA reading, an open case is about to breach once 0.8 of its target has
 * passed (`backend/app/engine/metrics.py` `SLA_AT_RISK_FRACTION`), and the report sends
 * that share as `sla_aging.warn_fraction`. The Console's empty block used to carry 0.75.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EMPTY_SLA_AGING, normalizeReport } from '@/soc/pages/Standup.report.api';

const METRICS = path.resolve(__dirname, '../../../../backend/app/engine/metrics.py');

function serverFraction(): number {
  const match = /^SLA_AT_RISK_FRACTION\s*=\s*([0-9.]+)\s*$/m.exec(readFileSync(METRICS, 'utf8'));
  expect(match, 'metrics.SLA_AT_RISK_FRACTION is defined').not.toBeNull();
  return Number(match![1]);
}

describe('the Standup SLA at-risk share', () => {
  it('is the server value', () => {
    expect(serverFraction()).toBe(0.8);
    expect(EMPTY_SLA_AGING.warn_fraction).toBe(serverFraction());
  });

  it('reads the server value when a report omits its SLA block', () => {
    expect(normalizeReport({ enabled: false }).sla_aging.warn_fraction).toBe(serverFraction());
    expect(normalizeReport(null).sla_aging.warn_fraction).toBe(serverFraction());
  });

  it('keeps the value the server sent', () => {
    const report = normalizeReport({
      sla_aging: { ...EMPTY_SLA_AGING, enabled: true, warn_fraction: 0.8 },
    });
    expect(report.sla_aging.warn_fraction).toBe(0.8);
  });
});
