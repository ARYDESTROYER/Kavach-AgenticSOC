/**
 * The `/` and `@` catalogue (SPEC §10.4): only commands whose tools are allowed,
 * report templates, saved prompts after commands, `@` scopes with denied ones disabled
 * and naming the permission, and the expansion rules that keep a typed indicator the
 * analyst's own text (origin `user`, SPEC §4.8).
 */
import { describe, expect, it } from 'vitest';
import type { ChatPrompt } from '@/lib/types';
import {
  atMenuGroups,
  expandTemplate,
  parseAtQuery,
  parseSlashQuery,
  removeAtToken,
  reportTemplateText,
  REPORT_TEMPLATE_SPECS,
  missingGrant,
  scopeAccess,
  slashAction,
  slashMenuGroups,
  toolsAllowed,
  toolUsable,
  TURNED_OFF_COPY,
  type ComposerMenuItem,
} from '../commands';
import { ALL_TOOLS, makeContext } from './fixtures';

/** A context where the deployment switched these tools off (allowed stays true, SPEC A30). */
function withTurnedOff(names: string[], tools = ALL_TOOLS) {
  return makeContext({
    tools: tools.map((t) => (names.includes(t.name) ? { ...t, available: false } : { ...t })),
  });
}

const values = (groups: ReturnType<typeof slashMenuGroups>) => groups.flatMap((g) => g.items.map((i) => i.value));
const prompts: ChatPrompt[] = [
  { id: 'a', title: 'Weekly phishing review', text: 'Summarise phishing cases this week.' },
  { id: 'b', title: 'VPN anomalies', text: 'Any odd VPN logins?' },
];

describe('parseSlashQuery', () => {
  it('reads the command word and its argument from a one-line draft', () => {
    expect(parseSlashQuery('/')).toEqual({ command: '', arg: '', hasSpace: false });
    expect(parseSlashQuery('/Hu')).toEqual({ command: 'hu', arg: '', hasSpace: false });
    expect(parseSlashQuery('/hunt 8.8.8.8')).toEqual({ command: 'hunt', arg: '8.8.8.8', hasSpace: true });
  });
  it('is not a command mid-text or across lines', () => {
    expect(parseSlashQuery('what is /hunt')).toBeNull();
    expect(parseSlashQuery('/hunt x\nmore')).toBeNull();
    expect(parseSlashQuery('')).toBeNull();
  });
});

describe('slash menu', () => {
  it('offers every command when all tools are allowed, then saved prompts', () => {
    const groups = slashMenuGroups(parseSlashQuery('/')!, makeContext(), prompts);
    expect(groups.map((g) => g.heading)).toEqual(['Commands', 'Saved prompts']);
    expect(values(groups)).toEqual([
      'cmd:shift-brief',
      'cmd:report',
      'cmd:posture',
      'cmd:hunt',
      'cmd:case',
      'cmd:cost',
      'cmd:sources',
      'cmd:help',
      'prompt:0',
      'prompt:1',
    ]);
  });

  it('hides commands whose tools are denied, and everything without a catalogue', () => {
    const restricted = makeContext({}, { cost_usage: 'cost:view', search_logs: 'sources:read', source_health: 'sources:read' });
    const listed = values(slashMenuGroups(parseSlashQuery('/')!, restricted, []));
    expect(listed).not.toContain('cmd:cost');
    expect(listed).not.toContain('cmd:hunt');
    expect(listed).not.toContain('cmd:sources');
    expect(listed).toContain('cmd:posture');
    expect(values(slashMenuGroups(parseSlashQuery('/')!, null, []))).toEqual([]);
  });

  it('filters by the typed prefix and matches saved prompts by title or text', () => {
    expect(values(slashMenuGroups(parseSlashQuery('/po')!, makeContext(), prompts))).toEqual(['cmd:posture']);
    expect(values(slashMenuGroups(parseSlashQuery('/vpn')!, makeContext(), prompts))).toEqual(['prompt:1']);
  });

  it('keeps one command with its argument after a space', () => {
    const groups = slashMenuGroups(parseSlashQuery('/hunt 8.8.8.8')!, makeContext(), prompts);
    expect(values(groups)).toEqual(['cmd:hunt']);
    const item = groups[0].items[0];
    expect(item.kind === 'command' && item.arg).toBe('8.8.8.8');
  });

  it('lists only the report templates whose tools are allowed', () => {
    const all = values(slashMenuGroups(parseSlashQuery('/report ')!, makeContext(), []));
    expect(all).toEqual(REPORT_TEMPLATE_SPECS.map((s) => `report:${s.template}`));
    const noIntel = values(slashMenuGroups(parseSlashQuery('/report ')!, makeContext({}, { lookup_indicator: 'enrichment:read' }), []));
    expect(noIntel).not.toContain('report:ioc');
    expect(values(slashMenuGroups(parseSlashQuery('/report sh')!, makeContext(), []))).toEqual(['report:shift']);
  });
});

describe('slashAction', () => {
  const item = (value: string, query: string) =>
    slashMenuGroups(parseSlashQuery(query)!, makeContext(), prompts)
      .flatMap((g) => g.items)
      .find((i) => i.value === value) as ComposerMenuItem;

  it('sends a fixed question for a command without an argument', () => {
    expect(slashAction(item('cmd:posture', '/'))).toEqual({
      type: 'send',
      text: 'How is our security posture right now? Show the key metrics and how they are trending.',
    });
  });

  it('fills the composer and selects the placeholder for an argument command', () => {
    const action = slashAction(item('cmd:hunt', '/'));
    expect(action?.type).toBe('insert');
    if (action?.type !== 'insert') return;
    const [start, end] = action.expansion.selection!;
    expect(action.expansion.text.slice(start, end)).toBe('<indicator>');
  });

  it('uses the typed argument and never sends it as a command', () => {
    const action = slashAction(item('cmd:hunt', '/hunt 8.8.8.8'));
    expect(action).toEqual({
      type: 'insert',
      expansion: {
        text: 'Hunt for 8.8.8.8 across logs, cases and threat intel. What do we know about it?',
        selection: null,
      },
    });
  });

  it('opens the template list for /report and inserts a section request', () => {
    expect(slashAction(item('cmd:report', '/'))).toEqual({ type: 'insert', expansion: { text: '/report ', selection: null } });
    const shift = slashAction(item('report:shift', '/report '));
    expect(shift).toEqual({
      type: 'insert',
      expansion: { text: 'Build a shift report with these sections: Summary, Open work, Key metrics, Next steps.', selection: null },
    });
  });

  it('inserts a saved prompt verbatim', () => {
    expect(slashAction(item('prompt:0', '/'))).toEqual({
      type: 'insert',
      expansion: { text: 'Summarise phishing cases this week.', selection: null },
    });
  });
});

describe('expandTemplate', () => {
  it('appends text to a template without a slot', () => {
    expect(expandTemplate('Show posture.', 'for last week', null)).toEqual({
      text: 'Show posture. for last week',
      selection: null,
    });
  });
  it('builds the investigation request around the case placeholder', () => {
    const spec = REPORT_TEMPLATE_SPECS.find((s) => s.template === 'investigation')!;
    expect(reportTemplateText(spec)).toBe(
      'Build an investigation report on {arg} with these sections: Summary, Evidence, Timeline, Decision, Next steps.',
    );
  });
});

describe('@ scopes', () => {
  it('finds an @word at the caret, only at a word start', () => {
    expect(parseAtQuery('@lo', 3)).toEqual({ start: 0, end: 3, query: 'lo' });
    expect(parseAtQuery('show @ca please', 8)).toEqual({ start: 5, end: 8, query: 'ca' });
    expect(parseAtQuery('mail user@corp', 14)).toBeNull();
    expect(parseAtQuery('@logs and more', 14)).toBeNull();
  });

  it('lists scopes, hides active ones and disables denied ones with the permission', () => {
    const ctx = makeContext({}, { search_logs: 'sources:read', log_stats: 'sources:read' });
    const groups = atMenuGroups(parseAtQuery('@', 1)!, ctx, ['cases']);
    const items = groups.flatMap((g) => g.items);
    expect(items.map((i) => i.value)).toEqual(['scope:logs', 'scope:metrics', 'scope:intel', 'scope:docs', 'scope:platform']);
    const logs = items[0];
    expect(logs.kind === 'scope' && logs.disabled).toBe(true);
    expect(logs.hint).toBe('Needs sources:read');
  });

  it('filters by id or label prefix and closes when nothing matches', () => {
    const ctx = makeContext();
    expect(atMenuGroups(parseAtQuery('@thr', 4)!, ctx, []).flatMap((g) => g.items.map((i) => i.value))).toEqual([
      'scope:intel',
    ]);
    expect(atMenuGroups(parseAtQuery('@zzz', 4)!, ctx, [])).toEqual([]);
  });

  it('removes the completed token and the space it leaves', () => {
    expect(removeAtToken('@lo failed logins', parseAtQuery('@lo failed logins', 3)!)).toEqual({
      text: 'failed logins',
      caret: 0,
    });
    expect(removeAtToken('failed @ca logins', parseAtQuery('failed @ca logins', 10)!)).toEqual({
      text: 'failed logins',
      caret: 7,
    });
  });

  it('derives per-scope access from the catalogue', () => {
    const access = scopeAccess(makeContext({}, { cost_usage: 'cost:view', source_health: 'sources:read' }));
    expect(access.find((a) => a.scope === 'platform')).toMatchObject({ allowed: false, missing: 'cost:view' });
    expect(access.find((a) => a.scope === 'docs')).toMatchObject({ allowed: true, missing: null });
    expect(toolsAllowed(makeContext(), ['unknown_tool'])).toBe(false);
  });

  it('treats a tool the deployment switched off as unusable, though allowed (SPEC A30)', () => {
    const ctx = withTurnedOff(['lookup_indicator']);
    const lookup = ctx.tools.find((t) => t.name === 'lookup_indicator')!;
    expect(lookup.allowed).toBe(true);
    expect(toolUsable(lookup)).toBe(false);
    expect(toolsAllowed(ctx, ['lookup_indicator'])).toBe(false);
    expect(toolsAllowed(ctx, ['search_logs'])).toBe(true);
    // Absent `available` means on.
    expect(toolsAllowed(makeContext(), ['lookup_indicator'])).toBe(true);
  });

  it('keeps a scope usable while one of its tools is on, and says when all are off', () => {
    // intel still has mitre_lookup on.
    expect(scopeAccess(withTurnedOff(['lookup_indicator'])).find((a) => a.scope === 'intel')).toMatchObject({
      allowed: true,
      turnedOff: false,
    });
    const allOff = withTurnedOff(['lookup_indicator', 'mitre_lookup']);
    expect(scopeAccess(allOff).find((a) => a.scope === 'intel')).toMatchObject({
      allowed: false,
      missing: null,
      turnedOff: true,
    });
    const intel = atMenuGroups(parseAtQuery('@int', 4)!, allOff, []).flatMap((g) => g.items)[0];
    expect(intel.kind === 'scope' && intel.disabled).toBe(true);
    expect(intel.hint).toBe(TURNED_OFF_COPY);
  });

  it('hides a command whose tool the deployment switched off', () => {
    const listed = values(slashMenuGroups(parseSlashQuery('/')!, withTurnedOff(['cost_usage']), []));
    expect(listed).not.toContain('cmd:cost');
    expect(listed).toContain('cmd:hunt');
  });

  it('joins a kind-gated tool\'s grants with "or" and required grants with "and"', () => {
    const base = { name: 't', label: 'T', scope: 'platform' as const, allowed: false };
    expect(missingGrant({ ...base, requires: [], missing: ['a:r', 'b:r'], kind_requires: { x: 'a:r', y: 'b:r' } })).toBe(
      'a:r or b:r',
    );
    expect(missingGrant({ ...base, requires: ['a:r', 'b:r'], missing: ['a:r', 'b:r'] })).toBe('a:r and b:r');
    expect(missingGrant({ ...base, requires: ['a:r'], missing: [] })).toBe('a:r');
    expect(missingGrant({ ...base, allowed: true, requires: ['a:r'] })).toBeNull();
  });
});
