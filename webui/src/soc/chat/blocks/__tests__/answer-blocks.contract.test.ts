/**
 * Answer-block contract (chat revamp SPEC §7, BLOCKS.md): every client enum, the
 * §7.3 view table, the §7.4 limits, the shared grammars and the invisible-character
 * ranges EXACTLY equal the committed `answer-blocks.contract.json` — the same file
 * the backend test pins `agents/blocks.py` to. The semantic axes are additionally
 * pinned to the palette maps the renderers colour by, so a new severity/status/
 * verdict cannot silently render uncoloured.
 */
import { describe, expect, it } from 'vitest';

import contract from '@/soc/chat/blocks/answer-blocks.contract.json';
import { SEVERITY_COLOR, STATUS_COLOR, VERDICT_COLOR } from '@/soc/components/palette';
import {
  AI_AUTHORED_TYPES,
  ALLOWED_VIEWS,
  ARTIFACT_KINDS,
  BLOCK_TYPES,
  BLOCK_VIEWS,
  BLOCKS_VERSION,
  CASE_STATUS_KEYS,
  CHART_KINDS,
  CITATION_KINDS,
  COLUMN_TYPES,
  DEFAULT_VIEW,
  ENTITY_KINDS,
  EXPIRED_TEXT,
  FALLBACK_TEXT,
  GOOD_DIRECTIONS,
  KPI_DISPLAYS,
  LIMITS,
  NAV_STATUSES,
  PATTERN_SOURCES,
  PROVENANCES,
  parseTimestamp,
  QUERY_LANGUAGES,
  REPORT_TEMPLATES,
  REPUTATION_VERDICTS,
  SEVERITY_KEYS,
  STATUS_KEYS,
  TIME_BUCKETS,
  TIMELINE_KINDS,
  TONES,
  VALUE_UNITS,
  VERDICT_KEYS,
  X_KINDS,
} from '@/soc/chat/blocks/schema';
import { INVISIBLE_TEXT_CLASS, INVISIBLE_TEXT_RANGES, displayText } from '@/soc/chat/stream-events';
import { isSafeCaseResultStatus } from '@/soc/case-result-route';

const c = contract as unknown as Record<string, unknown>;

describe('answer-blocks contract', () => {
  it('pins the version', () => {
    expect(contract.blocks_version).toBe(BLOCKS_VERSION);
  });

  it.each([
    ['block_types', BLOCK_TYPES],
    ['chart_kinds', CHART_KINDS],
    ['units', VALUE_UNITS],
    ['column_types', COLUMN_TYPES],
    ['tones', TONES],
    ['provenance', PROVENANCES],
    ['artifact_kinds', ARTIFACT_KINDS],
    ['views', BLOCK_VIEWS],
    ['kpi_displays', KPI_DISPLAYS],
    ['severity_keys', SEVERITY_KEYS],
    ['status_keys', STATUS_KEYS],
    ['case_status_keys', CASE_STATUS_KEYS],
    ['verdict_keys', VERDICT_KEYS],
    ['entity_kinds', ENTITY_KINDS],
    ['reputation_verdicts', REPUTATION_VERDICTS],
    ['timeline_kinds', TIMELINE_KINDS],
    ['citation_kinds', CITATION_KINDS],
    ['query_languages', QUERY_LANGUAGES],
    ['x_kinds', X_KINDS],
    ['time_buckets', TIME_BUCKETS],
    ['good_directions', GOOD_DIRECTIONS],
    ['report_templates', REPORT_TEMPLATES],
    ['nav_statuses', NAV_STATUSES],
  ] as const)('pins %s (ordered)', (key, values) => {
    expect([...values]).toEqual(c[key]);
  });

  it('pins the model-authorable types', () => {
    expect([...AI_AUTHORED_TYPES].sort()).toEqual([...contract.ai_authored_types].sort());
  });

  it('pins the §7.3 view table; the first view of each row is the default', () => {
    expect(ALLOWED_VIEWS).toEqual(contract.allowed_views);
    for (const kind of ARTIFACT_KINDS) {
      expect(DEFAULT_VIEW[kind]).toBe(ALLOWED_VIEWS[kind][0]);
    }
  });

  it('pins every §7.4 limit', () => {
    expect(LIMITS).toEqual(contract.limits);
  });

  it('pins the grammars, and each compiles as a JS RegExp', () => {
    expect(PATTERN_SOURCES).toEqual(contract.patterns);
    for (const source of Object.values(PATTERN_SOURCES)) {
      expect(() => new RegExp(source)).not.toThrow();
    }
  });

  it('pins the invisible-character ranges and the stub texts', () => {
    expect(INVISIBLE_TEXT_RANGES.map(([lo, hi]) => [lo, hi])).toEqual(contract.invisible_ranges);
    expect(FALLBACK_TEXT).toBe(contract.fallback_text);
    expect(EXPIRED_TEXT).toBe(contract.expired_text);
  });

  it('keeps the semantic axes equal to the palette maps the renderers colour by', () => {
    expect([...SEVERITY_KEYS].sort()).toEqual(Object.keys(SEVERITY_COLOR).sort());
    expect([...STATUS_KEYS].sort()).toEqual(Object.keys(STATUS_COLOR).sort());
    expect([...VERDICT_KEYS].sort()).toEqual(Object.keys(VERDICT_COLOR).sort());
  });

  it('keeps the nav status opt equal to the router guard', () => {
    for (const status of NAV_STATUSES) expect(isSafeCaseResultStatus(status)).toBe(true);
    expect(isSafeCaseResultStatus('teleported')).toBe(false);
  });

  it('accepts and rejects exactly the shared timestamp examples (same list as the backend)', () => {
    for (const value of contract.timestamp_examples.valid) {
      expect(Number.isNaN(parseTimestamp(value)), value).toBe(false);
    }
    for (const value of contract.timestamp_examples.invalid) {
      expect(Number.isNaN(parseTimestamp(value)), value).toBe(true);
    }
    // Naive is UTC; offsets shift; a fraction is kept to the millisecond.
    expect(parseTimestamp('2026-10-08T10:10:10')).toBe(Date.UTC(2026, 9, 8, 10, 10, 10));
    expect(parseTimestamp('2026-10-08T10:10:10+0200')).toBe(Date.UTC(2026, 9, 8, 8, 10, 10));
    expect(parseTimestamp('2026-10-08 10:10:10.123456789z')).toBe(Date.UTC(2026, 9, 8, 10, 10, 10, 123));
    expect(parseTimestamp('0001-01-01')).toBe(-62135596800000);
  });

  it('builds an astral-safe invisible class from the shared ranges', () => {
    // Every range bound is stripped, and the code points just outside are not, so
    // the astral ranges cannot have been mangled into "U+E000 followed by 0".
    for (const [lo, hi] of INVISIBLE_TEXT_RANGES) {
      expect(displayText(`a${String.fromCodePoint(lo)}b${String.fromCodePoint(hi)}c`, 0)).toBe('abc');
    }
    expect(displayText('\ue000 0 \u{1bca4} \u{e1000} \u{1d172}', 0)).toBe('\ue000 0 \u{1bca4} \u{e1000} \u{1d172}');
    expect(INVISIBLE_TEXT_CLASS).toContain('\\u{e0000}-\\u{e0fff}');
  });
});
