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
  COMPACT_ARGUMENT_HINT,
  expandTemplate,
  parseAtQuery,
  parseSlashQuery,
  promptHint,
  starterHint,
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
  LIBRARY_ITEM_VALUE,
  MENU_HINT_MAX,
  SLASH_COMMANDS,
  sectionsHint,
} from '../commands';
import { SCOPE_DESCRIPTIONS } from '../format';
import { STARTER_PROMPTS } from '../prompt-library';
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
  it('offers every command when all tools are allowed, then your prompts and the library', () => {
    const groups = slashMenuGroups(parseSlashQuery('/')!, makeContext(), prompts, { canCompact: true });
    expect(groups.map((g) => g.heading)).toEqual(['Commands', 'Your prompts', 'Prompt library']);
    expect(values(groups)).toEqual([
      'cmd:shift-brief',
      'cmd:report',
      'cmd:posture',
      'cmd:hunt',
      'cmd:case',
      'cmd:cost',
      'cmd:sources',
      'cmd:help',
      'cmd:compact',
      'prompt:a',
      'prompt:b',
      LIBRARY_ITEM_VALUE,
    ]);
  });

  it('lists favorites first among your prompts', () => {
    const starred: ChatPrompt[] = [prompts[0], { ...prompts[1], favorite: true }];
    const groups = slashMenuGroups(parseSlashQuery('/')!, makeContext(), starred);
    expect(groups.find((g) => g.heading === 'Your prompts')?.items.map((i) => i.value)).toEqual(['prompt:b', 'prompt:a']);
  });

  it('shows a promptbook\'s steps in order as its hint, never the stored --- separators', () => {
    const book: ChatPrompt = {
      id: 'book-t1',
      title: 'Case triage',
      text: 'Open case {case id}.\n---\nRelated cases to {case id}?\n---\nWrite next steps.',
    };
    const groups = slashMenuGroups(parseSlashQuery('/case')!, makeContext(), [...prompts, book]);
    const item = groups.find((g) => g.heading === 'Your prompts')?.items.find((i) => i.value === 'prompt:book-t1');
    expect(item?.hint).toBe('3 steps: Open case {case id}. → Related cases to {case id}? → Write next steps.');
    expect(item?.hint).not.toContain('---');
    // An ordinary prompt keeps its text.
    expect(promptHint(prompts[1])).toBe('Any odd VPN logins?');
    expect(promptHint({ id: 'book-x', text: 'Only one step.' })).toBe('1 step: Only one step.');
  });

  it('offers /compact with a one-line description, but not in bounded mode (Round 12 D4)', () => {
    const saved = { canCompact: true };
    const compact = slashMenuGroups(parseSlashQuery('/comp')!, makeContext(), [], saved)
      .flatMap((g) => g.items)
      .find((i) => i.value === 'cmd:compact');
    expect(compact?.hint).toBe('Summarise earlier messages to make room');
    expect(slashAction(compact!)).toEqual({ type: 'send', text: '/compact' });
    const bounded = values(slashMenuGroups(parseSlashQuery('/')!, makeContext({ limits_mode: 'bounded' }), [], saved));
    expect(bounded).not.toContain('cmd:compact');
    expect(values(slashMenuGroups(parseSlashQuery('/')!, makeContext({ limits_mode: 'unlimited' }), [], saved))).toContain('cmd:compact');
  });

  it('offers /compact only in a saved conversation (a new chat has no summary to keep)', () => {
    expect(values(slashMenuGroups(parseSlashQuery('/')!, makeContext(), []))).not.toContain('cmd:compact');
    expect(values(slashMenuGroups(parseSlashQuery('/comp')!, makeContext(), [], { canCompact: false }))).toEqual([]);
    expect(values(slashMenuGroups(parseSlashQuery('/compact')!, makeContext(), [], { canCompact: true }))).toEqual(['cmd:compact']);
  });

  it('sends the bare /compact even with text after it (the engine knows only the word)', () => {
    const groups = slashMenuGroups(parseSlashQuery('/compact the hosts')!, makeContext(), [], { canCompact: true });
    const item = groups[0].items[0];
    expect(item.value).toBe('cmd:compact');
    expect(item.kind === 'command' && item.arg).toBe('');
    expect(item.hint).toBe(COMPACT_ARGUMENT_HINT);
    expect(slashAction(item)).toEqual({ type: 'send', text: '/compact' });
    // Even an item built with an argument never inserts it into a billed question.
    expect(slashAction({ ...item, arg: 'the hosts' } as typeof item)).toEqual({ type: 'send', text: '/compact' });
  });

  it('searches prompts by their whole title once a space is typed after a word that is not a command', () => {
    const library: ChatPrompt[] = [
      { id: 'book-w', title: 'Weekly review', text: 'Last week\n---\nThe week before' },
      { id: 'p-h', title: 'Hunt IP', text: 'Hunt for {ip} in the last 7 days.' },
    ];
    // Your promptbook and the starter of the same name.
    expect(values(slashMenuGroups(parseSlashQuery('/weekly re')!, makeContext(), library))).toEqual(['prompt:book-w', 'prompt:starter:book-weekly-review']);
    // Starter prompts are found the same way (multi-word titles).
    const starters = slashMenuGroups(parseSlashQuery('/failed sign')!, makeContext(), []);
    expect(starters.map((g) => g.heading)).toEqual(['Starter prompts']);
    expect(values(starters)).toEqual(['prompt:starter:failed-sign-ins']);
    // The library entry by its two-word name.
    expect(values(slashMenuGroups(parseSlashQuery('/prompt library')!, makeContext(), []))).not.toContain('cmd:report');
    // A command keeps its argument item first; a prompt titled like it is listed after.
    const hunt = slashMenuGroups(parseSlashQuery('/hunt ip')!, makeContext(), library);
    expect(values(hunt)).toEqual(['cmd:hunt', 'prompt:p-h']);
    expect(hunt[0].items[0].kind === 'command' && hunt[0].items[0].arg).toBe('ip');
    // Nothing matches: an empty menu (Enter then sends the text as typed).
    expect(values(slashMenuGroups(parseSlashQuery('/nothing like this')!, makeContext(), library))).toEqual([]);
  });

  it('adds starter prompts by title or category once three letters are typed, and the library on /lib', () => {
    const pos = slashMenuGroups(parseSlashQuery('/pos')!, makeContext(), []);
    expect(pos.map((g) => g.heading)).toEqual(['Commands', 'Starter prompts']);
    expect(pos[1].items.every((i) => i.kind === 'prompt' && i.prompt.starter && i.prompt.category === 'posture')).toBe(true);
    // Two letters never pull starters in.
    expect(values(slashMenuGroups(parseSlashQuery('/po')!, makeContext(), []))).toEqual(['cmd:posture']);
    // A starter is offered only when every tool it needs is allowed.
    const noMetrics = values(slashMenuGroups(parseSlashQuery('/noise')!, makeContext({}, { soc_metrics: 'metrics:view' }), []));
    expect(noMetrics).toEqual([]);
    expect(values(slashMenuGroups(parseSlashQuery('/lib')!, makeContext(), []))).toEqual([LIBRARY_ITEM_VALUE]);
    expect(slashAction(slashMenuGroups(parseSlashQuery('/lib')!, makeContext(), [])[0].items[0])).toEqual({ type: 'library' });
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
    expect(values(slashMenuGroups(parseSlashQuery('/vpn')!, makeContext(), prompts))).toEqual(['prompt:b']);
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
    // "Create" asks for a report to be SAVED to Reports, not only shown (Round 12 D11).
    expect(shift).toEqual({
      type: 'insert',
      expansion: { text: 'Create a shift report with these sections: Summary, Open work, Key metrics, Next steps.', selection: null },
    });
  });

  it('covers the Round 12 templates: executive, monthly, infographic and investigation brief', () => {
    const monthly = slashAction(item('report:monthly', '/report '));
    expect(monthly?.type).toBe('insert');
    if (monthly?.type !== 'insert') return;
    expect(monthly.expansion.text).toBe(
      'Create a monthly SOC report for <month> with these sections: Summary, Volume by week, Quality, Response times, Noise reduction, Top cases, Next steps.',
    );
    const [start, end] = monthly.expansion.selection!;
    expect(monthly.expansion.text.slice(start, end)).toBe('<month>');
    const typed = slashAction(item('report:executive', '/report executive Q3 2026'));
    expect(typed?.type === 'insert' && typed.expansion.text).toBe(
      'Create an executive summary report for Q3 2026 with these sections: Summary, Volume, Quality, Response times, Noise reduction, Next steps.',
    );
    const brief = REPORT_TEMPLATE_SPECS.find((s) => s.template === 'investigation_brief')!;
    expect(reportTemplateText(brief)).toBe(
      'Create an investigation brief on {arg} with these sections: Assessment, Key findings, Affected entities, ATT&CK, Next steps, What could not be checked.',
    );
    const infographic = REPORT_TEMPLATE_SPECS.find((s) => s.template === 'infographic')!;
    expect(reportTemplateText(infographic)).toMatch(/^Create an infographic report for \{arg\} with these sections: Key figures/);
    // Every report template the backend knows is offered.
    expect(REPORT_TEMPLATE_SPECS.map((s) => s.template).sort()).toEqual(
      ['custom', 'executive', 'hunt', 'infographic', 'investigation', 'investigation_brief', 'ioc', 'monthly', 'posture', 'shift'].sort(),
    );
    // case_stats gates the performance templates (fail closed).
    const noStats = values(slashMenuGroups(parseSlashQuery('/report ')!, makeContext({}, { case_stats: 'cases:read' }), []));
    expect(noStats).not.toContain('report:monthly');
    expect(noStats).toContain('report:shift');
  });

  it('inserts a saved prompt verbatim', () => {
    expect(slashAction(item('prompt:a', '/'))).toEqual({
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
      'Create an investigation report on {arg} with these sections: Summary, Evidence, Timeline, Decision, Next steps.',
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
    expect(logs.hint).toBe('Needs permission to read sources (sources:read)');
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

describe('menu descriptions (Round 13, SPEC-chat T22)', () => {
  it('keeps every description the console writes to at most 60 characters', () => {
    expect(MENU_HINT_MAX).toBe(60);
    const ours = [
      ...SLASH_COMMANDS.map((c) => c.description),
      COMPACT_ARGUMENT_HINT,
      ...Object.values(SCOPE_DESCRIPTIONS),
      TURNED_OFF_COPY,
      'Needs permission to read sources (sources:read)',
    ];
    for (const text of ours) expect(text.length, text).toBeLessThanOrEqual(MENU_HINT_MAX);
    // Every report template's row, built from its sections.
    const all = slashMenuGroups(parseSlashQuery('/report ')!, makeContext(), []).flatMap((g) => g.items);
    expect(all.length).toBe(REPORT_TEMPLATE_SPECS.length);
    for (const row of all) expect(row.hint.length, row.hint).toBeLessThanOrEqual(MENU_HINT_MAX);
    // And the library entry.
    const library = slashMenuGroups(parseSlashQuery('/')!, makeContext(), []).flatMap((g) => g.items).find((i) => i.kind === 'library');
    expect(library?.hint.length).toBeLessThanOrEqual(MENU_HINT_MAX);
  });

  it('describes every ready-made prompt in console copy of at most 60 characters, never its full text', () => {
    for (const prompt of STARTER_PROMPTS) {
      const hint = starterHint(prompt);
      expect(hint.length, `${prompt.id}: ${hint}`).toBeLessThanOrEqual(MENU_HINT_MAX);
      expect(hint).not.toBe(prompt.text);
    }
    const byId = (id: string) => STARTER_PROMPTS.find((p) => p.id === id)!;
    expect(starterHint(byId('starter:hunt-indicator'))).toBe('Hunt · Asks for Indicator, Period');
    expect(starterHint(byId('starter:failed-sign-ins'))).toBe('Hunt · Asks for User');
    expect(starterHint(byId('starter:needs-review'))).toBe('Triage');
    expect(starterHint(byId('starter:book-triage-case'))).toBe('Triage · 3 steps · Asks for Case id');
    // Too many names to fit: the values are counted.
    const many = { ...byId('starter:hunt-indicator'), text: '{first value name} {second value name} {third value name} {fourth one}' };
    expect(starterHint(many)).toBe('Hunt · Asks for 4 values');
    // The `/` menu uses it for starters and keeps the analyst's own text for theirs.
    const rows = slashMenuGroups(parseSlashQuery('/hunt')!, makeContext(), []).flatMap((g) => g.items);
    const hunt = rows.find((row) => row.value === 'prompt:starter:hunt-indicator');
    expect(hunt?.hint).toBe('Hunt · Asks for Indicator, Period');
    for (const row of rows) if (row.kind === 'prompt') expect(row.hint.length, row.hint).toBeLessThanOrEqual(MENU_HINT_MAX);
  });

  it('lists whole section names, then how many more', () => {
    expect(sectionsHint(['Summary', 'Open work', 'Key metrics', 'Next steps'])).toBe(
      'Summary · Open work · Key metrics · Next steps',
    );
    const monthly = REPORT_TEMPLATE_SPECS.find((spec) => spec.template === 'monthly')!;
    expect(sectionsHint(monthly.sections)).toBe('Summary · Volume by week · Quality · Response times · 3 more');
    // Never a cut word: a single section longer than the limit is counted instead.
    expect(sectionsHint(['x'.repeat(70), 'y'])).toBe('2 sections');
  });
});
