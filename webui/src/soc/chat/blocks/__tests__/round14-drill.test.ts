/**
 * Round 14 chat drill and severity, the pure half (SPEC §4.6.3, §4.6.6, §4.7.3, F7):
 *
 * - the drill refs a table or chart row carries (a `rule` ref opens the rule sheet and is
 *   never a route; a Logs ref may name a severity or a rule), validated with the shared
 *   contract's vectors and limits; a model-made block carries none (G5);
 * - a row's trend (its newest 24 points) and the severity breakdown a table carries,
 *   parsed leniently (five levels in fixed order, zeros, bounded rules and splits);
 * - the rule sheet's target from a ref, and the "Back to answer" memory;
 * - the breakdown's helpers (splits, Top items and "+N more rules", the Logs view of one
 *   rule at one level, the matrix rows, the footnote) and the words in labels.ts;
 * - one sample read twice by the backend (by rule and by severity): a rule's count is the
 *   same in both answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import contract from '../answer-blocks.contract.json';
import sample from './fixtures/severity-sample.json';
import { ANSWER_ORIGIN_TTL_MS, answerOrigin, clearAnswerOrigin, rememberAnswerOrigin } from '../../../answer-origin';
import { caseStatusWord } from '../../display';
import { levelLabel, levelRawText, levelScaleText, sampleSentence, shareText, subjectNoun } from '../labels';
import { ANSWER_ORIGIN, ruleSheetTarget } from '../rule-drill';
import { LINE_MIN_POINTS, trendGeometry, trendRuns } from '../renderers/RowTrend';
import {
  availableSplits,
  defaultSplit,
  levelToggleSuffix,
  matrixOffered,
  matrixRows,
  ruleLevelLogsRef,
  severityFootnote,
  splitMenuShown,
  topItems,
} from '../renderers/SeverityBreakdownView';
import {
  DRILL_KEYS,
  DRILL_LIMITS,
  RULE_PAGE,
  SEVERITY_SPLIT_KEYS,
  SEVERITY_SUBJECTS,
  isRuleRef,
  parseBlock,
  parseDrillRef,
  parseInternalRef,
  parseRuleRef,
  parseSeverityBreakdown,
} from '../schema';
import type { ChartBlock, SeverityBreakdown, TableBlock } from '../schema';

const severityBlock = () => parseBlock(structuredClone(sample.severity)) as TableBlock & { severity: SeverityBreakdown };
const rulesTable = () => parseBlock(structuredClone(sample.rules_table)) as TableBlock;
const rulesChart = () => parseBlock(structuredClone(sample.rules_chart)) as ChartBlock;

describe('the drill contract (shared with blocks.py)', () => {
  it('pins the rule page, the drill keys, the splits, the subjects and the limits', () => {
    expect(RULE_PAGE).toBe(contract.drill.rule_page);
    expect([...DRILL_KEYS]).toEqual(contract.drill.keys);
    expect([...SEVERITY_SPLIT_KEYS]).toEqual(contract.drill.severity_split_keys);
    expect([...SEVERITY_SUBJECTS]).toEqual(contract.drill.severity_subjects);
    expect(DRILL_LIMITS).toEqual(contract.drill.limits);
  });

  it('takes every valid rule on the rule page and on Logs, and refuses every invalid one', () => {
    for (const rule of contract.nav_drill_examples.valid.rule) {
      expect(parseRuleRef({ page: 'rule', opts: { rule } })?.opts.rule).toBe(rule);
      expect(parseInternalRef({ page: 'logs', opts: { rule } })?.opts?.rule).toBe(rule);
    }
    for (const rule of contract.nav_drill_examples.invalid.rule) {
      expect(parseRuleRef({ page: 'rule', opts: { rule } })).toBeNull();
      expect(parseInternalRef({ page: 'logs', opts: { rule } })).toBeNull();
    }
  });

  it('takes the five named levels on Logs and refuses anything else', () => {
    for (const severity of contract.nav_drill_examples.valid.severity) {
      expect(parseInternalRef({ page: 'logs', opts: { severity } })?.opts?.severity).toBe(severity);
    }
    for (const severity of contract.nav_drill_examples.invalid.severity) {
      expect(parseInternalRef({ page: 'logs', opts: { severity } })).toBeNull();
    }
  });

  it('reads a rule ref whole or not at all', () => {
    const window = { from: '2026-10-26T00:00:00Z', to: '2026-10-29T00:00:00Z' };
    expect(parseRuleRef({ page: 'rule', opts: { rule: 'ssh brute', ...window, sourceId: 'wazuh-prod' } })).toEqual({
      page: 'rule',
      opts: { rule: 'ssh brute', ...window, sourceId: 'wazuh-prod' },
    });
    // The rule is required; an unknown or malformed opt, or an extra key, invalidates it.
    expect(parseRuleRef({ page: 'rule', opts: window })).toBeNull();
    expect(parseRuleRef({ page: 'rule', opts: { rule: 'x', caseId: 'case-1' } })).toBeNull();
    expect(parseRuleRef({ page: 'rule', opts: { rule: 'x', from: 'yesterday' } })).toBeNull();
    expect(parseRuleRef({ page: 'rule', opts: { rule: 'x' }, href: 'javascript:alert(1)' })).toBeNull();
    // A drill list takes either kind; a rule page is never a route.
    expect(isRuleRef(parseDrillRef({ page: 'rule', opts: { rule: 'x' } }))).toBe(true);
    expect(parseInternalRef({ page: 'rule', opts: { rule: 'x' } })).toBeNull();
    expect(parseDrillRef({ page: 'logs', opts: { severity: 'high' } })).toEqual({ page: 'logs', opts: { severity: 'high' } });
  });
});

describe('table and chart drills, trends and the severity breakdown', () => {
  it('keeps a rule ref per row and a trend per row, aligned with the rows', () => {
    const block = rulesTable();
    expect(block.drill).toHaveLength(block.rows.length);
    expect(block.drill?.every(isRuleRef)).toBe(true);
    expect(block.drill?.map((d) => (isRuleRef(d) ? d.opts.rule : null))).toEqual(block.rows.map((r) => r[0]));
    expect(block.trend).toHaveLength(block.rows.length);
    const chart = rulesChart();
    expect(chart.drill?.map((d) => (isRuleRef(d) ? d.opts.rule : null))).toEqual(chart.x.values);
  });

  it('cuts drills and trends to the rows, pads with null and keeps the newest 24 points', () => {
    const base = structuredClone(sample.rules_table) as Record<string, unknown>;
    const long = Array.from({ length: 30 }, (_, i) => i);
    const block = parseBlock({
      ...base,
      drill: [{ page: 'rule', opts: { rule: 'a' } }, { page: 'rule', opts: { rule: 'bad\u202e' } }],
      trend: [long, [1, 'x', 3]],
    }) as TableBlock;
    expect(block.drill).toHaveLength(4);
    expect(block.drill?.[1]).toBeNull();
    expect(block.drill?.slice(2)).toEqual([null, null]);
    expect(block.trend?.[0]).toEqual(long.slice(-24));
    expect(block.trend?.[1]).toEqual([1, null, 3]);
    expect(block.trend?.[2]).toBeNull();
    // Nothing usable: no list at all.
    const none = parseBlock({ ...base, drill: [{ page: 'nowhere' }], trend: [] }) as TableBlock;
    expect(none.drill).toBeUndefined();
    expect(none.trend).toBeUndefined();
  });

  it('gives a model-made block no destination at all (G5)', () => {
    const ai = parseBlock({ ...structuredClone(sample.severity), provenance: 'ai' }) as TableBlock;
    expect(ai.drill).toBeUndefined();
    expect(ai.severity?.levels.some((l) => l.drill)).toBe(false);
    expect(ai.severity?.levels.flatMap((l) => l.rules).some((r) => r.drill)).toBe(false);
    expect(Object.values(ai.severity?.splits.source ?? {}).flatMap((s) => s?.top ?? []).some((t) => t.drill)).toBe(false);
    // The counts stay: only the links go.
    expect(ai.severity?.levels.map((l) => l.count)).toEqual(severityBlock().severity.levels.map((l) => l.count));
    const aiChart = parseBlock({ ...structuredClone(sample.rules_chart), provenance: 'ai' }) as ChartBlock;
    expect(aiChart.drill).toBeUndefined();
  });

  it('reads the severity breakdown the server built: five levels, zeros, raws, rules and splits', () => {
    const { severity } = severityBlock();
    expect(severity.subject).toBe('events');
    expect(severity.levels.map((l) => l.level)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(severity.levels.map((l) => l.count)).toEqual([4, 7, 0, 2, 0]);
    expect(severity.levels.map((l) => l.share)).toEqual([30.8, 53.8, 0, 15.4, 0]);
    expect(levelRawText(severity.levels[1])).toBe('8, 7, 55');
    expect(severity.levels[1].drill).toMatchObject({ page: 'logs', opts: { severity: 'high' } });
    expect(severity.levels[1].rules.every((r) => isRuleRef(r.drill))).toBe(true);
    expect(Object.keys(severity.splits)).toEqual(['rule', 'source']);
    expect(severity.multi_level_rules).toBe(2);
    expect(severity.sample).toMatchObject({ counted: 13, total: 48, exact: false, sources_sampled: 1 });
  });

  it('repairs a hostile breakdown instead of trusting it', () => {
    const rules = Array.from({ length: 25 }, (_, i) => ({ key: `r${i}`, count: 25 - i }));
    const severity = parseSeverityBreakdown({
      subject: 'nonsense',
      levels: [
        { level: 'info', count: 3, share: 150 },
        { level: 'high', count: -4, share: 12.345, rules, rules_total: 2 },
        { level: 'HIGH', count: 99 },
        { level: 'high', count: 50 },
        { level: 'unknown', count: 1 },
      ],
      splits: { host: { high: { top: [{ key: 'h', count: 1 }] } }, source: { high: { top: [{ key: '', count: 1 }], other: 2 }, bogus: {} } },
      multi_level_rules: 'many',
    });
    expect(severity.subject).toBe('events');
    expect(severity.levels.map((l) => l.level)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    const high = severity.levels[1];
    // The first entry of a level counts; a negative count is zero; a share past 100 is not stated.
    expect(high.count).toBe(0);
    expect(high.share).toBe(12.3);
    expect(severity.levels[4].share).toBeNull();
    // At most 20 rules; the total never reads below the rules listed.
    expect(high.rules).toHaveLength(DRILL_LIMITS.severity_rules);
    expect(high.rules_total).toBe(20);
    // A missing level is a zero; an unknown split name or level, or a blank key, is dropped.
    expect(severity.levels[0]).toMatchObject({ count: 0, rules: [], rules_total: 0 });
    expect(Object.keys(severity.splits)).toEqual(['source']);
    expect(severity.splits.source?.high).toEqual({ top: [], other: 2 });
    expect(severity.multi_level_rules).toBe(0);
  });
});

describe('the rule sheet target and the way back', () => {
  afterEach(() => {
    clearAnswerOrigin();
    window.location.hash = '';
  });

  it('opens on the answer window and source, from "your answer"', () => {
    expect(ruleSheetTarget({ page: 'rule', opts: { rule: 'r', from: '2026-10-26T00:00:00Z', to: '2026-10-29T00:00:00Z', sourceId: 's1' } })).toEqual({
      rule: 'r',
      window: { from: '2026-10-26T00:00:00Z', to: '2026-10-29T00:00:00Z' },
      sourceId: 's1',
      origin: ANSWER_ORIGIN,
    });
    // An open end runs to now; all time has no bounds (the sheet's own default).
    expect(ruleSheetTarget({ page: 'rule', opts: { rule: 'r', from: 'now-3d' } }).window).toEqual({ from: 'now-3d', to: 'now' });
    expect(ruleSheetTarget({ page: 'rule', opts: { rule: 'r' } }, 'CASE-000214')).toEqual({
      rule: 'r',
      window: undefined,
      sourceId: undefined,
      origin: 'CASE-000214',
    });
    expect(ANSWER_ORIGIN).toBe('your answer');
  });

  it('remembers the answer page only, for the drill it led to', async () => {
    window.location.hash = '#/chat?conversationId=conv-1';
    rememberAnswerOrigin(null, 1_000);
    expect(answerOrigin(2_000)).toEqual({ hash: '#/chat?conversationId=conv-1', label: 'Back to answer' });
    // Stale after the TTL.
    expect(answerOrigin(1_000 + ANSWER_ORIGIN_TTL_MS + 1)).toBeNull();
    // A case's chat goes back to the case.
    window.location.hash = '#/case_manager?caseId=case-1';
    rememberAnswerOrigin(null, 1_000);
    expect(answerOrigin(1_000)?.label).toBe('Back to the case');
    // Case Manager without a case is the queue, not the case the answer was on.
    window.location.hash = '#/case_manager';
    rememberAnswerOrigin(null, 1_000);
    expect(answerOrigin(1_000)).toBeNull();
    // A page that shows no answers is nothing to go back to.
    window.location.hash = '#/overview';
    rememberAnswerOrigin(null, 1_000);
    expect(answerOrigin(1_000)).toBeNull();
    rememberAnswerOrigin({ conversationId: 'c-2', messageId: 'm1' }, 1_000);
    expect(answerOrigin(1_000)).toBeNull();
  });

  it('goes back to the exact answer, never to whichever thread Chat would reopen', async () => {
    // The Chat workspace's location is the bare `#/chat` while a thread is open from the rail.
    window.location.hash = '#/chat';
    await vi.waitFor(() => expect(window.location.hash).toBe('#/chat'));
    rememberAnswerOrigin({ conversationId: 'c-2', messageId: 'm1' }, 1_000);
    expect(answerOrigin(1_000)).toEqual({ hash: '#/chat?conversationId=c-2&messageId=m1', label: 'Back to answer' });
    // The explicit answer wins over a location that names another thread.
    window.location.hash = '#/chat?conversationId=conv-9';
    rememberAnswerOrigin({ conversationId: 'c-2' }, 1_000);
    expect(answerOrigin(1_000)?.hash).toBe('#/chat?conversationId=c-2');
    // A message id outside the id grammar is dropped, never written into the link.
    rememberAnswerOrigin({ conversationId: 'c-2', messageId: 'm 1&x=y' }, 1_000);
    expect(answerOrigin(1_000)?.hash).toBe('#/chat?conversationId=c-2');
    // Unknown answer on the bare `#/chat`: nothing rather than a way to another thread.
    window.location.hash = '#/chat';
    await vi.waitFor(() => expect(window.location.hash).toBe('#/chat'));
    rememberAnswerOrigin(null, 1_000);
    expect(answerOrigin(1_000)).toBeNull();
    rememberAnswerOrigin({ conversationId: '../x' }, 1_000);
    expect(answerOrigin(1_000)).toBeNull();
  });

  it('forgets the answer once the person moves on, or comes back to it', async () => {
    const hashChange = () => new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.location.hash = '#/chat?conversationId=conv-1';
    await vi.waitFor(() => expect(window.location.hash).toBe('#/chat?conversationId=conv-1'));
    rememberAnswerOrigin();
    let changed = hashChange();
    window.location.hash = '#/logs?rule=ssh';
    await changed;
    // The drill's own page still offers the way back.
    expect(answerOrigin()?.hash).toBe('#/chat?conversationId=conv-1');
    changed = hashChange();
    window.location.hash = '#/cases';
    await changed;
    expect(answerOrigin()).toBeNull();
    // Back at the answer: forgotten too.
    rememberAnswerOrigin();
    expect(answerOrigin()).toBeNull();
    window.location.hash = '#/chat?conversationId=conv-2';
    await vi.waitFor(() => expect(window.location.hash).toBe('#/chat?conversationId=conv-2'));
    rememberAnswerOrigin();
    changed = hashChange();
    window.location.hash = '#/logs';
    await changed;
    changed = hashChange();
    window.location.hash = '#/chat?conversationId=conv-2';
    await changed;
    expect(answerOrigin()).toBeNull();
  });

  it('answers only where the drill landed, even before a later location\'s event arrives', async () => {
    const hashChange = () => new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.location.hash = '#/chat?conversationId=conv-1';
    await vi.waitFor(() => expect(window.location.hash).toBe('#/chat?conversationId=conv-1'));
    rememberAnswerOrigin();
    // The router writes the drill's location at once; the page reads before its event.
    let changed = hashChange();
    window.location.hash = '#/logs?rule=ssh';
    expect(answerOrigin()?.hash).toBe('#/chat?conversationId=conv-1');
    await changed;
    expect(answerOrigin()?.hash).toBe('#/chat?conversationId=conv-1');
    // A later link opened from that view: written, its event not yet arrived. It is not
    // the drill's view, so it gets nothing.
    changed = hashChange();
    window.location.hash = '#/logs?rule=web_scan';
    expect(answerOrigin()).toBeNull();
    await changed;
    expect(answerOrigin()).toBeNull();
    // Back to the drill's view through history: forgotten, never offered again.
    changed = hashChange();
    window.location.hash = '#/logs?rule=ssh';
    await changed;
    expect(answerOrigin()).toBeNull();
  });
});

describe('row trends', () => {
  it('draws measured points only, a gap never as zero', () => {
    const geo = trendGeometry([0, null, 4, 2]);
    expect(geo[1]).toBeNull();
    expect(geo[2]?.y).toBeLessThan(geo[0]!.y);
    expect(LINE_MIN_POINTS).toBe(5);
  });

  it('keeps a measured point between two gaps as a run of its own', () => {
    const runs = trendRuns(trendGeometry([5, null, 3, null, 4, 6, 7]));
    expect(runs.map((r) => r.length)).toEqual([1, 1, 3]);
  });
});

describe('the severity breakdown helpers', () => {
  it('names a level disclosure for what opening it shows, never a list it does not hold', () => {
    const logs = { page: 'logs' as const, opts: { severity: 'low' } };
    expect(levelToggleSuffix({ drill: logs }, 3, 'rule')).toBe(', list its rules');
    expect(levelToggleSuffix({ drill: logs }, 2, 'source')).toBe(', list its sources');
    // No rule names in the level: the panel holds only the level's own view.
    expect(levelToggleSuffix({ drill: logs }, 0, 'rule')).toBe(', show the link to its Logs view');
    expect(levelToggleSuffix({ drill: { page: 'cases' } }, 0, 'rule')).toBe(', show the link to its cases');
    expect(levelToggleSuffix({}, 0, 'rule')).toBe(', show details');
  });

  it('offers rules then sources, Split by only for two splits, the matrix only for a rule in two levels', () => {
    const { severity } = severityBlock();
    expect(availableSplits(severity)).toEqual(['rule', 'source']);
    expect(defaultSplit(severity)).toBe('rule');
    expect(splitMenuShown(severity)).toBe(true);
    expect(matrixOffered(severity)).toBe(true);
    const one = { ...severity, splits: { rule: severity.splits.rule }, multi_level_rules: 0 };
    expect(splitMenuShown(one)).toBe(false);
    expect(matrixOffered(one)).toBe(false);
    expect(defaultSplit({ ...severity, levels: severity.levels.map((l) => ({ ...l, rules: [] })), splits: {} })).toBe('none');
  });

  it('lists up to three in the Top cell, then "+N more rules" from the level total', () => {
    const { severity } = severityBlock();
    const many = {
      ...severity.levels[0],
      rules: Array.from({ length: 20 }, (_, i) => ({ key: `r${i}`, count: 20 - i })),
      rules_total: 25,
    };
    expect(topItems(severity, many, 'rule')).toMatchObject({ more: '+22 more rules' });
    expect(topItems(severity, many, 'rule').items).toHaveLength(3);
    expect(topItems(severity, { ...many, rules: many.rules.slice(0, 3), rules_total: 4 }, 'rule').more).toBe('+1 more rule');
    expect(topItems(severity, severity.levels[1], 'rule').more).toBeNull();
    const sources = topItems(severity, severity.levels[1], 'source');
    expect(sources.items.map((i) => i.key)).toEqual(['QRadar', 'Wazuh prod', 'Elastic']);
    expect(topItems(severity, severity.levels[1], 'none')).toEqual({ items: [], more: null });
  });

  it('builds the Logs view of one rule at one level only from the two server refs', () => {
    const { severity } = severityBlock();
    const high = severity.levels[1];
    const ref = ruleLevelLogsRef(high, high.rules[0]);
    expect(ref).toEqual({
      page: 'logs',
      opts: { ...high.drill!.opts, rule: 'Web scanner user agent detected' },
    });
    // No rule ref, no level view, or another source: no link.
    expect(ruleLevelLogsRef(high, { key: 'x', count: 1 })).toBeNull();
    expect(ruleLevelLogsRef({ drill: undefined }, high.rules[0])).toBeNull();
    const pinned = { drill: { page: 'logs' as const, opts: { severity: 'high' as const, sourceId: 'a' } } };
    expect(ruleLevelLogsRef(pinned, { key: 'x', count: 1, drill: { page: 'rule', opts: { rule: 'x', sourceId: 'b' } } })).toBeNull();
  });

  it('lays rules out by level, the rules in two levels first', () => {
    const rows = matrixRows(severityBlock().severity);
    expect(rows.slice(0, 2).map((r) => r.levels)).toEqual([2, 2]);
    const ssh = rows.find((r) => r.item.key === 'Fehlgeschlagene Anmeldung über SSH')!;
    expect(ssh.byLevel.critical?.count).toBe(3);
    expect(ssh.byLevel.high?.count).toBe(2);
    expect(ssh.total).toBe(5);
  });

  it('says how levels are named, and states the sample only when the caption does not', () => {
    const block = severityBlock();
    expect(severityFootnote(block.severity, block.caption)).toBe(
      "Levels use each source's own scale; the raw value is in brackets. Share is of the 13 events counted.",
    );
    expect(severityFootnote(block.severity, undefined)).toBe(
      "Levels use each source's own scale; the raw value is in brackets. 13 of 48 events counted: 2 sources exactly, 1 sampled at the newest 200 each. Share is of the 13 events counted.",
    );
    const exact = { ...block.severity, sample: { ...block.severity.sample!, exact: true, sources_sampled: 0, total: 13 } };
    expect(severityFootnote(exact, undefined)).toBe("Levels use each source's own scale; the raw value is in brackets.");
    expect(severityFootnote({ ...exact, subject: 'cases', levels: exact.levels.map((l) => ({ ...l, raw_values: [] })) }, undefined)).toBe('');
  });

  it('agrees with the rule table of the same sample, rule by rule', () => {
    const table = rulesTable();
    const summed = new Map<string, number>();
    for (const level of severityBlock().severity.levels) {
      for (const rule of level.rules) {
        const key = isRuleRef(rule.drill) ? rule.drill.opts.rule : rule.key;
        summed.set(key, (summed.get(key) ?? 0) + rule.count);
      }
    }
    const fromTable = new Map(table.rows.map((row, i) => [isRuleRef(table.drill?.[i]) ? table.drill![i]!.opts!.rule! : String(row[0]), row[1]]));
    expect(Object.fromEntries(summed)).toEqual(Object.fromEntries(fromTable));
  });
});

describe('labels: levels and case status words', () => {
  it('names a level with its raw values and each source scale', () => {
    const high = severityBlock().severity.levels[1];
    expect(levelLabel(high)).toBe('High (8, 7, 55)');
    expect(levelScaleText(high)).toBe('8 on a 0 to 15 scale, 7 on a 0 to 10 scale and 55 on a 0 to 100 scale');
    expect(levelLabel({ level: 'medium', raw_values: [] })).toBe('Medium');
    expect(levelRawText({ raw_values: [{ value: 7.25, scale_max: 10 }, { value: 7.25, scale_max: 15 }] })).toBe('7.3');
    expect(shareText(0)).toBe('0.0%');
    expect(shareText(null)).toBe('Not stated');
  });

  it('mirrors the backend sample sentences', () => {
    const s = (counted: number, total: number | null, sampled: number, exact: number) => ({
      counted,
      total,
      per_source_cap: 200,
      exact: false,
      sources_exact: exact,
      sources_sampled: sampled,
    });
    expect(sampleSentence(s(1000, 2500, 5, 0), 'events')).toBe('1,000 of 2,500 events sampled, newest 200 per source');
    expect(sampleSentence(s(200, 900, 1, 0), 'events')).toBe('200 of 900 events sampled, newest 200 from the source');
    expect(sampleSentence(s(1400, 2900, 3, 2), 'events')).toBe('1,400 of 2,900 events counted: 2 sources exactly, 3 sampled at the newest 200 each');
    expect(sampleSentence(s(200, null, 1, 0), 'events')).toBe('200 of an unknown number of events sampled, newest 200 from the source');
    expect(sampleSentence({ ...s(1000, 1000, 0, 3), exact: true }, 'events')).toBeNull();
    expect(sampleSentence(undefined, 'cases')).toBeNull();
  });

  it('says a case card status in the one table of Console words (the StatusBadge words)', () => {
    expect(caseStatusWord('needs_human')).toBe('Open · awaiting analyst');
    expect(caseStatusWord('ESCALATED')).toBe('Escalated');
    expect(caseStatusWord('on_hold')).toBe('On hold');
    // Not a case status: shown as written by the caller, never reworded.
    expect(caseStatusWord('Customer asked us to hold it')).toBeNull();
  });

  it('never writes an em dash or the retired procedure word', () => {
    const block = parseBlock(structuredClone(sample.severity)) as TableBlock;
    const sev = block.severity!;
    const sampled = { counted: 1400, total: 2900, per_source_cap: 200, exact: false, sources_exact: 2, sources_sampled: 3 };
    const words = [
      ...['new', 'open', 'needs_human', 'investigating', 'escalated', 'on_hold', 'resolved', 'closed'].map((k) => caseStatusWord(k)!),
      ...sev.levels.flatMap((level) => [levelLabel(level), levelScaleText(level), shareText(level.share)]),
      sampleSentence(sampled, 'events')!,
      sampleSentence({ ...sampled, sources_exact: 0 }, 'cases')!,
      severityFootnote(sev, undefined),
      subjectNoun('cases', 1),
      shareText(null),
    ];
    for (const w of words) {
      expect(w).not.toMatch(/\u2014/);
      expect(w).not.toMatch(/\s\u2013\s/);
      expect(w).not.toMatch(/playbook/i);
    }
  });
});
