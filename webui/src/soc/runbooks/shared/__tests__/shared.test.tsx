/**
 * The shared runbook pieces (Round 14, SPEC §4.10): the one https-only link helper, the
 * match explanation sentences, progress chips, review dates, the automation target
 * resolution behind "Needs a runbook", and the error reader.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '@/lib/api';
import type { RunbookSummary } from '@/lib/types-runbooks';

import { RunbookExternalLink, safeHttpsUrl } from '../links';
import { describeExplanation, missedSentence } from '../explain';
import { progressChipLabel, progressChipText, progressLine } from '../progress';
import { isReviewDue, reviewDueState, reviewDueWords } from '../dates';
import {
  LEGACY_BUNDLED_PLAYBOOK_IDS,
  LEGACY_BUNDLED_RUNBOOK_MAP,
  PROCEDURE_NAMESPACES,
  migratedProceduresFromLibrary,
  resolveAutomationRunbook,
} from '../legacy';
import { isCaseFiguresHidden, runbookFailure } from '../errors';
import { StatusMark } from '../chips';
import { windowLabel } from '../labels';

function summary(over: Partial<RunbookSummary> = {}): RunbookSummary {
  return {
    id: 'brute-force-password-spray',
    title: 'Brute force and password spray',
    summary: 'Many failed sign-ins.',
    origin: 'builtin',
    state: 'published',
    live_version: 1,
    draft_version: null,
    in_review_version: null,
    retired: false,
    replaces: null,
    replaced_by: null,
    derived_from: null,
    owner: null,
    phases: ['triage'],
    step_count: 3,
    applies_to: { rule_ids: ['ssh_auth_failed'], mitre: ['T1110'], more: 0 },
    runs_30d: null,
    review_due_at: null,
    last_reviewed_at: null,
    last_reviewed_by: null,
    updated_at: null,
    updated_by: null,
    migrated_from: null,
    ...over,
  };
}

describe('the one https-only link helper', () => {
  it('accepts an absolute https link and returns it normalised', () => {
    expect(safeHttpsUrl('https://attack.mitre.org/techniques/T1110/')).toBe('https://attack.mitre.org/techniques/T1110/');
  });

  it.each([
    ['javascript:alert(1)'],
    ['http://example.com/'],
    ['data:text/html,<b>x</b>'],
    ['//example.com/path'],
    ['https://user:pass@example.com/'],
    [' https://example.com/'],
    ['https://exa mple.com/'],
    ['https:\\\\example.com'],
    ['https://example.com/\u202e'],
    [''],
    [42],
    [`https://example.com/${'a'.repeat(500)}`],
  ])('refuses %s', (value) => {
    expect(safeHttpsUrl(value)).toBeNull();
  });

  it('renders a safe link as a new-tab anchor and anything else as plain text', () => {
    const { rerender } = render(<RunbookExternalLink href="https://example.com/a">Advisory</RunbookExternalLink>);
    const link = screen.getByRole('link', { name: /Advisory/ });
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    rerender(<RunbookExternalLink href="javascript:alert(1)">javascript:alert(1)</RunbookExternalLink>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.getByText(/not a secure https link/)).toBeInTheDocument();
  });
});

describe('match explanation sentences', () => {
  it('names what matched, the fallback and a tie', () => {
    expect(
      describeExplanation({
        tier: 3,
        matched: [
          { criterion: 'rule_ids', value: 'ssh_auth_failed' },
          { criterion: 'mitre', value: 'T1110' },
        ],
        missed: [],
        tie: false,
      }),
    ).toBe('Matched rule ssh_auth_failed and technique T1110.');
    expect(describeExplanation({ tier: 0, matched: [], missed: [], tie: false })).toBe(
      'Fallback: no other runbook matched this case.',
    );
    expect(describeExplanation({ tier: 1, matched: [{ criterion: 'entity_types', value: 'ip' }], missed: [], tie: true }, 2)).toMatch(
      /2 runbooks matched equally; the first by name was chosen\.$/,
    );
  });

  it('says why a criterion failed in plain words', () => {
    expect(missedSentence({ criterion: 'severity_at_least', expected: 'medium', actual: 'low' })).toBe('Severity low is below medium.');
    expect(missedSentence({ criterion: 'min_event_count', expected: 20, actual: 3 })).toBe('3 events is below 20.');
    expect(missedSentence({ criterion: 'verdicts', expected: ['TRUE_POSITIVE'], actual: null })).toMatch(/is not known yet/);
  });
});

describe('progress chips and lines', () => {
  const p = { done: 4, not_applicable: 1, total: 11, required_open: 5, blocked: 1, waiting: 1 };
  it('reads "4/11 · 1 blocked · 1 waiting" and a full sentence for assistive tech', () => {
    expect(progressChipText(p)).toBe('4/11 · 1 blocked · 1 waiting');
    expect(progressChipLabel(p)).toMatch(/4 of 11 steps done/);
    expect(progressLine(p)).toMatch(/^4 of 11 steps done/);
  });
});

describe('lookup windows in words', () => {
  it('says every window form the built-ins use, and the tokens, in words', () => {
    const cases: Array<[string, string]> = [
      ['case_first_seen-1h..case_last_seen+1h', 'From an hour before the case was first seen to an hour after it was last seen'],
      ['case_first_seen-1d..case_last_seen+1h', 'From a day before the case was first seen to an hour after it was last seen'],
      ['case_first_seen-1d..now', 'From a day before the case was first seen to now'],
      ['case_first_seen..case_last_seen+1d', 'From when the case was first seen to a day after it was last seen'],
      ['case_last_seen-1d..case_last_seen+1h', 'From a day before the case was last seen to an hour after it was last seen'],
      ['case_last_seen-30d..case_last_seen', "The 30 days up to the case's last event"],
      ['case_last_seen-7d..case_last_seen+1h', 'From 7 days before the case was last seen to an hour after it was last seen'],
      ['now-24h', 'The last 24 hours'],
      ['now-7d', 'The last 7 days'],
      ['now-1d..now', 'The last day'],
      ['today', 'Today'],
      ['yesterday', 'Yesterday'],
      ['this_week', 'This week'],
      ['last_week', 'Last week'],
    ];
    for (const [window, words] of cases) expect(windowLabel(window)).toBe(words);
  });

  it('falls back to the default for an empty window and to the text for one it cannot read', () => {
    expect(windowLabel('')).toBe('From an hour before the case was first seen to an hour after it was last seen');
    expect(windowLabel('2026-10-01..2026-10-02')).toBe('2026-10-01..2026-10-02');
    expect(windowLabel('case_first_seen-1y..now')).toBe('case_first_seen-1y..now');
  });
});

describe('review dates', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-10-29T12:00:00Z');
  it('says overdue, due today and in N days', () => {
    expect(reviewDueState(new Date(now - 2 * day).toISOString(), now)).toBe('overdue');
    expect(reviewDueWords(new Date(now - 2 * day).toISOString(), now)).toBe('Overdue');
    expect(reviewDueWords(new Date(now + 4 * day).toISOString(), now)).toBe('in 4 days');
    expect(reviewDueWords(null, now)).toBe('');
  });

  it('compares calendar days in the viewer zone, so a review just after midnight is tomorrow', () => {
    // 23:00 local today; the review is due at 00:30 local tomorrow (90 minutes later).
    const lateEvening = new Date(2026, 9, 29, 23, 0, 0).getTime();
    const justAfterMidnight = new Date(2026, 9, 30, 0, 30, 0).toISOString();
    expect(reviewDueState(justAfterMidnight, lateEvening)).toBe('soon');
    expect(reviewDueWords(justAfterMidnight, lateEvening)).toBe('in 1 day');
    expect(isReviewDue(justAfterMidnight, lateEvening)).toBe(false);
    // Earlier the same calendar day is still due today, not overdue.
    const earlierToday = new Date(2026, 9, 29, 0, 5, 0).toISOString();
    expect(reviewDueState(earlierToday, lateEvening)).toBe('today');
    expect(reviewDueWords(earlierToday, lateEvening)).toBe('Due today');
    // Yesterday late evening is overdue at one minute past midnight.
    expect(reviewDueState(new Date(2026, 9, 28, 23, 59).toISOString(), new Date(2026, 9, 29, 0, 1).getTime())).toBe('overdue');
  });
});

describe('which runbook a case-automation rule attaches', () => {
  const library = [
    summary(),
    summary({ id: 'my-draft', title: 'My draft', origin: 'operator', state: 'draft', live_version: null, draft_version: 1 }),
    summary({ id: 'old-proc-imported', title: 'Imported', origin: 'imported', migrated_from: { namespace: 'playbooks', id: 'old_proc', revision: 3 } }),
  ];

  it('mirrors the 18 retired bundled ids of the server map', () => {
    expect(Object.keys(LEGACY_BUNDLED_RUNBOOK_MAP)).toHaveLength(18);
    expect(LEGACY_BUNDLED_RUNBOOK_MAP.brute_force_login).toBe('brute-force-password-spray');
  });

  it('resolves in the server order: runbook_id, the migration, then the map', () => {
    expect(resolveAutomationRunbook({ runbook_id: 'brute-force-password-spray' }, library)).toMatchObject({
      status: 'attaches',
      via: 'runbook_id',
    });
    expect(resolveAutomationRunbook({ playbook_id: 'old_proc' }, library)).toMatchObject({
      status: 'attaches',
      id: 'old-proc-imported',
      via: 'migration',
    });
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, library)).toMatchObject({
      status: 'attaches',
      id: 'brute-force-password-spray',
      via: 'legacy_map',
    });
    // runbook_id wins over a playbook_id that would resolve elsewhere.
    expect(resolveAutomationRunbook({ runbook_id: 'brute-force-password-spray', playbook_id: 'old_proc' }, library).id).toBe(
      'brute-force-password-spray',
    );
  });

  it('never answers a retired bundled procedure id from a stored document (a shadowed copy is a draft)', () => {
    expect(LEGACY_BUNDLED_PLAYBOOK_IDS.size).toBe(9);
    for (const id of LEGACY_BUNDLED_PLAYBOOK_IDS) expect(LEGACY_BUNDLED_RUNBOOK_MAP[id]).toBeTruthy();
    const shadowed = [
      ...library,
      summary({
        id: 'brute_force_login-imported',
        title: 'Brute force (imported)',
        origin: 'imported',
        state: 'draft',
        live_version: null,
        draft_version: 1,
        migrated_from: { namespace: 'playbooks', id: 'brute_force_login', revision: 2 },
      }),
    ];
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, shadowed)).toMatchObject({
      status: 'attaches',
      id: 'brute-force-password-spray',
      via: 'legacy_map',
    });
  });

  it('reads the migration only for the procedure namespaces, the configured folder first', () => {
    const fromReference = [
      summary({ id: 'mail-imported', origin: 'imported', migrated_from: { namespace: 'runbooks', id: 'mail_abuse', revision: 1 } }),
      summary({ id: 'phishing-suspicious-email', title: 'Phishing' }),
    ];
    // A reference runbook document never answered a rule: mail_abuse goes through the map.
    expect(resolveAutomationRunbook({ playbook_id: 'mail_abuse' }, fromReference)).toMatchObject({
      id: 'phishing-suspicious-email',
      via: 'legacy_map',
    });
    const both = [
      summary({ id: 'from-store', origin: 'imported', migrated_from: { namespace: 'playbooks', id: 'triage', revision: 1 } }),
      summary({ id: 'from-folder', origin: 'imported', migrated_from: { namespace: 'playbook_dir', id: 'triage', revision: 1 } }),
    ];
    expect(resolveAutomationRunbook({ playbook_id: 'triage' }, both).id).toBe('from-folder');
  });

  it('answers a retired bundled procedure id from the configured folder (what the rule ran)', () => {
    const folder = [
      summary(),
      summary({
        id: 'brute-force-ours',
        title: 'Brute force (ours)',
        origin: 'imported',
        migrated_from: { namespace: 'playbook_dir', id: 'brute_force_login', revision: null },
      }),
    ];
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, folder)).toMatchObject({
      status: 'attaches',
      id: 'brute-force-ours',
      via: 'migration',
    });
    // The folder answers even when the stored documents also held the id.
    const both = [
      ...folder,
      summary({
        id: 'brute_force_login-imported',
        origin: 'imported',
        state: 'draft',
        live_version: null,
        draft_version: 1,
        migrated_from: { namespace: 'playbooks', id: 'brute_force_login', revision: 2 },
      }),
    ];
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, both).id).toBe('brute-force-ours');
  });

  it('rebuilds the server map from the rows with the same precedence (migrated_procedure_ids)', () => {
    const rows = [
      summary({ id: 'x', origin: 'imported', migrated_from: { namespace: 'playbooks', id: 'x', revision: 1 } }),
      summary({ id: 'x-dir', origin: 'imported', migrated_from: { namespace: 'playbook_dir', id: 'x', revision: null } }),
      summary({ id: 'shadow', origin: 'imported', migrated_from: { namespace: 'playbooks', id: 'malware_x', revision: 1 } }),
      summary({ id: 'bf-dir', origin: 'imported', migrated_from: { namespace: 'playbook_dir', id: 'brute_force_login', revision: null } }),
      summary({ id: 'bf-store', origin: 'imported', migrated_from: { namespace: 'playbooks', id: 'web_scanner_activity', revision: 1 } }),
      summary({ id: 'ref', origin: 'imported', migrated_from: { namespace: 'runbooks', id: 'mail_abuse', revision: 1 } }),
      summary({ id: 'plain', origin: 'operator' }),
    ];
    expect(migratedProceduresFromLibrary(rows)).toEqual({
      x: 'x-dir',
      malware_x: 'shadow',
      brute_force_login: 'bf-dir',
    });
  });

  it("prefers the server's map from the library read over the rows", () => {
    const rows = [
      summary(),
      summary({ id: 'from-rows', origin: 'imported', migrated_from: { namespace: 'playbooks', id: 'triage', revision: 1 } }),
      summary({ id: 'from-server', origin: 'imported' }),
    ];
    expect(resolveAutomationRunbook({ playbook_id: 'triage' }, rows, { triage: 'from-server' })).toMatchObject({
      status: 'attaches',
      id: 'from-server',
      via: 'migration',
    });
    // An empty map is the server's answer (nothing migrated): the rows are not scanned, so
    // the rule falls through to the legacy map, or to nothing.
    expect(resolveAutomationRunbook({ playbook_id: 'triage' }, rows, {})).toMatchObject({
      status: 'needs_runbook',
      id: null,
      via: null,
    });
    // Without the map (a caller that holds only the rows) the rows answer.
    expect(resolveAutomationRunbook({ playbook_id: 'triage' }, rows).id).toBe('from-rows');
    expect(resolveAutomationRunbook({ playbook_id: 'triage' }, rows, null).id).toBe('from-rows');
  });

  it('needs a runbook when the map names a runbook the library does not list (the server skips it)', () => {
    // The map answers before the legacy map, as on the server, so the built-in is not used.
    expect(
      resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, library, { brute_force_login: 'gone-runbook' }),
    ).toMatchObject({ status: 'needs_runbook', id: 'gone-runbook', runbook: null, via: 'migration' });
    // A blank entry answers nothing, as the server's text check reads it.
    expect(
      resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, library, { brute_force_login: '  ' }),
    ).toMatchObject({ status: 'attaches', id: 'brute-force-password-spray', via: 'legacy_map' });
  });

  it('follows the rows only while the migrated runbook is in the library, and the map after it is gone', () => {
    // A configured-folder copy of a retired bundled id, migrated as a Draft and then
    // discarded: the marker still maps the id, so the server skips the rule.
    const gone = [summary()];
    const marker = { brute_force_login: 'brute_force_login-imported' };
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, gone, marker)).toMatchObject({
      status: 'needs_runbook',
      id: 'brute_force_login-imported',
      runbook: null,
      via: 'migration',
    });
    // The rows alone cannot see that mapping any more.
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, gone)).toMatchObject({
      status: 'attaches',
      id: 'brute-force-password-spray',
      via: 'legacy_map',
    });
  });

  it('pins the documented limit of the filtered map for a viewer who cannot see unpublished runbooks', () => {
    // The server leaves the Draft and its map entry out for this viewer, so the retired
    // bundled id reads as attaching the built-in although the server skips the rule.
    const visible = [summary()];
    expect(resolveAutomationRunbook({ playbook_id: 'brute_force_login' }, visible, {})).toMatchObject({
      status: 'attaches',
      id: 'brute-force-password-spray',
      via: 'legacy_map',
    });
    // Any other id the filtered map leaves out resolves to nothing: it still needs a runbook.
    expect(resolveAutomationRunbook({ playbook_id: 'triage' }, visible, {})).toMatchObject({
      status: 'needs_runbook',
      id: null,
      via: null,
    });
  });

  it('reads only own keys of the maps, so an id such as constructor names nothing', () => {
    for (const playbookId of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(resolveAutomationRunbook({ playbook_id: playbookId }, library), playbookId).toMatchObject({
        status: 'needs_runbook',
        id: null,
        via: null,
      });
      expect(resolveAutomationRunbook({ playbook_id: playbookId }, library, {}).id, playbookId).toBeNull();
    }
  });

  it("mirrors the server's legacy ids and namespace order (runbook_model.py, runbook_migration.py)", () => {
    const engine = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../backend/app/engine');
    const model = readFileSync(resolve(engine, 'runbook_model.py'), 'utf8');
    const mapBody = /^LEGACY_BUNDLED_RUNBOOK_MAP[^=]*= \{([\s\S]*?)^\}/m.exec(model)?.[1] ?? '';
    const serverMap = Object.fromEntries([...mapBody.matchAll(/"([a-z_]+)": "([a-z-]+)"/g)].map((m) => [m[1], m[2]]));
    expect(serverMap).toEqual(LEGACY_BUNDLED_RUNBOOK_MAP);
    const idsBody = /^LEGACY_BUNDLED_PLAYBOOK_IDS[^=]*= frozenset\(\{([\s\S]*?)\}\)/m.exec(model)?.[1] ?? '';
    expect([...idsBody.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([...LEGACY_BUNDLED_PLAYBOOK_IDS].sort());
    const migration = readFileSync(resolve(engine, 'runbook_migration.py'), 'utf8');
    const constant = (name: string) => new RegExp(`^${name} = "([a-z_]+)"`, 'm').exec(migration)?.[1];
    const order = /^PROCEDURE_NAMESPACES[^=]*= \(([^)]*)\)/m.exec(migration)?.[1] ?? '';
    expect(order.split(',').map((name) => name.trim()).filter(Boolean).map(constant)).toEqual([...PROCEDURE_NAMESPACES]);
  });

  it('never treats a bare runbook id in playbook_id as a target (the server does not)', () => {
    expect(resolveAutomationRunbook({ playbook_id: 'brute-force-password-spray' }, library)).toMatchObject({
      status: 'needs_runbook',
      id: null,
    });
  });

  it('attaches a built-in that a published copy replaces (the server still attaches it by id)', () => {
    const replaced = [summary({ replaced_by: 'brute-force-ours' }), summary({ id: 'brute-force-ours', origin: 'operator' })];
    expect(resolveAutomationRunbook({ runbook_id: 'brute-force-password-spray' }, replaced).status).toBe('attaches');
  });

  it('needs a runbook when the target is unknown, a draft only or retired', () => {
    expect(resolveAutomationRunbook({ playbook_id: 'nothing_like_it' }, library).status).toBe('needs_runbook');
    expect(resolveAutomationRunbook({ runbook_id: 'my-draft' }, library).status).toBe('needs_runbook');
    expect(
      resolveAutomationRunbook({ runbook_id: 'gone' }, [summary({ id: 'gone', retired: true, state: 'retired' })]).status,
    ).toBe('needs_runbook');
    expect(resolveAutomationRunbook({}, library).status).toBe('needs_runbook');
    expect(resolveAutomationRunbook({ runbook_id: 'x' }, null).status).toBe('unknown');
  });
});

describe('the runbook API refusal reader', () => {
  it('reads code, issues and the latest detail', () => {
    const failure = runbookFailure(
      new ApiError(422, 'Fix the problems.', {
        detail: { code: 'runbook_invalid', message: 'Fix the problems.', issues: [{ path: 'title', code: 'required', message: 'Give it a title.' }] },
      }),
    );
    expect(failure.code).toBe('runbook_invalid');
    expect(failure.issues).toHaveLength(1);
    expect(isCaseFiguresHidden(runbookFailure(new ApiError(409, 'x', { detail: { code: 'runbook_scope_unsupported' } })))).toBe('scope');
    expect(isCaseFiguresHidden(runbookFailure(new ApiError(403, 'x')))).toBe('forbidden');
  });

  it('tells a taken id on a create apart from a stale revision', () => {
    const taken = runbookFailure(
      new ApiError(409, "A runbook with the id 'x' already exists. Choose another id.", {
        detail: { code: 'runbook_conflict', message: "A runbook with the id 'x' already exists. Choose another id.", exists: true },
      }),
    );
    expect(taken).toMatchObject({ code: 'runbook_conflict', exists: true });
    expect(runbookFailure(new ApiError(409, 'Stale.', { detail: { code: 'runbook_conflict', message: 'Stale.' } })).exists).toBe(false);
  });
});

describe('status marks', () => {
  it('names the status in words, so the glyph is never the only signal', () => {
    render(<StatusMark status="waiting" />);
    expect(screen.getByRole('img', { name: 'Waiting for approval' })).toBeInTheDocument();
  });
});
