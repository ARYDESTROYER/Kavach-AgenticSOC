import { describe, expect, it } from 'vitest';

import { DASH, humanizeToken } from '../format';
import { properName } from '../proper-names';

describe('properName (Round 14, SPEC §4.9.4)', () => {
  it('spells known products and acronyms as their owners do', () => {
    expect(properName('qradar')).toBe('QRadar');
    expect(properName('mitre')).toBe('MITRE');
    expect(properName('opensearch')).toBe('OpenSearch');
    expect(properName('crowdstrike')).toBe('CrowdStrike');
    expect(properName('sentinelone')).toBe('SentinelOne');
    expect(properName('gcp_pubsub')).toBe('GCP Pub/Sub');
    expect(properName('hec')).toBe('HEC');
    expect(properName('push_http')).toBe('Push HTTP');
  });

  it('matches the wire token case-insensitively and ignores surrounding space', () => {
    expect(properName('QRADAR')).toBe('QRadar');
    expect(properName(' Mitre ')).toBe('MITRE');
  });

  it('falls back to sentence case for any other token', () => {
    expect(properName('threat_context')).toBe(humanizeToken('threat_context'));
    expect(properName('elasticsearch')).toBe('Elasticsearch');
    expect(properName(null)).toBe(DASH);
    expect(properName('')).toBe(DASH);
  });

  it('never resolves an inherited property name (a token is source-controlled text)', () => {
    expect(properName('constructor')).toBe(humanizeToken('constructor'));
    expect(properName('__proto__')).toBe(humanizeToken('__proto__'));
    expect(properName('toString')).toBe(humanizeToken('toString'));
  });
});
