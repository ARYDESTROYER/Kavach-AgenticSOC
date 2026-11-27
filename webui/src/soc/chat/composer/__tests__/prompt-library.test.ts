/**
 * The prompt library's pure rules (Round 12 SPEC §3.1, SYNTHESIS-chat P1-8): placeholder
 * parsing and one-pass filling (a value is the analyst's own words and is never expanded
 * again), promptbook steps in the existing storage (id prefix + `---` lines, no backend
 * field), starter prompts gated by the tool catalogue (fail closed), search and order.
 */
import { describe, expect, it } from 'vitest';

import type { ChatPrompt } from '@/lib/types';
import { SAVED_PROMPT_ID_RE, SAVED_PROMPT_LIMITS, normaliseSavedPrompts } from '../../chat-api';
import {
  CATEGORY_LABEL,
  MAX_PROMPTBOOK_STEPS,
  PROMPTBOOK_ID_PREFIX,
  PROMPT_CATEGORIES,
  STARTER_PROMPTS,
  fillPrompt,
  filterPrompts,
  isPromptbook,
  joinPromptbookSteps,
  matchesPrompt,
  newPromptId,
  orderPrompts,
  paramKey,
  paramLabel,
  planIsDirect,
  planPrompt,
  promptParams,
  promptbookProblem,
  promptbookSteps,
  visibleStarters,
} from '../prompt-library';
import { makeContext } from './fixtures';

describe('placeholders', () => {
  it('finds each placeholder once, in order, across spellings and steps', () => {
    expect(promptParams('Hunt {indicator} in {period}, then {Indicator} again')).toEqual(['indicator', 'period']);
    expect(promptParams('Case {case id}', 'More on {case_id} and {host}')).toEqual(['case id', 'host']);
    expect(promptParams('No values here, {} or { spaced } or {1x}')).toEqual([]);
  });

  it('labels a placeholder in plain words', () => {
    expect(paramLabel('case_id')).toBe('Case id');
    expect(paramLabel('technique id')).toBe('Technique id');
    expect(paramKey('Case_ID')).toBe('case id');
  });

  it('fills every placeholder in one pass and never expands a value', () => {
    const values = { indicator: ' 8.8.8.8 ', period: '{indicator}' };
    expect(fillPrompt('Hunt {indicator} over {period}. {Indicator}!', values)).toBe('Hunt 8.8.8.8 over {indicator}. 8.8.8.8!');
    // A placeholder without a value stays as written.
    expect(fillPrompt('Look at {host}', {})).toBe('Look at {host}');
  });
});

describe('promptbooks', () => {
  it('stores steps in the prompt text with --- lines, and reads them back', () => {
    const text = joinPromptbookSteps(['Step one', ' Step two ', '', 'Step three']);
    expect(text).toBe('Step one\n---\nStep two\n---\nStep three');
    expect(promptbookSteps(text)).toEqual(['Step one', 'Step two', 'Step three']);
    expect(promptbookSteps('a\r\n----\r\nb\n---\n---\nc')).toEqual(['a', 'b', 'c']);
    expect(promptbookSteps(Array.from({ length: 14 }, (_, i) => `s${i}`).join('\n---\n'))).toHaveLength(MAX_PROMPTBOOK_STEPS);
  });

  it('is marked by its id prefix only (a --- line in a prompt does not make it a book)', () => {
    expect(isPromptbook({ id: `${PROMPTBOOK_ID_PREFIX}abc` })).toBe(true);
    expect(isPromptbook({ id: 'starter:book-weekly-review' })).toBe(true);
    expect(isPromptbook({ id: 'p-abc' })).toBe(false);
    expect(newPromptId(true).startsWith(PROMPTBOOK_ID_PREFIX)).toBe(true);
    expect(newPromptId(false).startsWith('p-')).toBe(true);
    for (const id of [newPromptId(true), newPromptId(false)]) expect(SAVED_PROMPT_ID_RE.test(id)).toBe(true);
  });

  it('needs two to ten steps', () => {
    expect(promptbookProblem('just one step')).toMatch(/at least 2 steps/);
    expect(promptbookProblem('a\n---\nb')).toBeNull();
    expect(promptbookProblem(Array.from({ length: 11 }, (_, i) => `s${i}`).join('\n---\n'))).toMatch(/at most 10/);
  });

  it('survives the stored-prompt normaliser (no backend field needed)', () => {
    const stored = normaliseSavedPrompts([
      { id: 'book-x1', title: 'Triage', text: 'one {case}\n---\ntwo {case}', category: 'triage', favorite: true },
    ]);
    expect(stored).toEqual([{ id: 'book-x1', title: 'Triage', text: 'one {case}\n---\ntwo {case}', category: 'triage', favorite: true }]);
    const plan = planPrompt(stored[0]);
    expect(plan).toMatchObject({ book: true, steps: ['one {case}', 'two {case}'], params: ['case'] });
    expect(planIsDirect(plan)).toBe(false);
  });

  it('drops an unknown category and a non-true favorite, like the backend', () => {
    expect(normaliseSavedPrompts([{ id: 'p1', title: 't', text: 'x', category: 'bogus', favorite: 'yes' }])).toEqual([
      { id: 'p1', title: 't', text: 'x' },
    ]);
  });
});

describe('starter prompts', () => {
  it('cover every category with read-only, well-formed templates', () => {
    for (const category of PROMPT_CATEGORIES) {
      expect(STARTER_PROMPTS.filter((p) => p.category === category.id).length, category.label).toBeGreaterThanOrEqual(3);
    }
    const ids = new Set<string>();
    for (const p of STARTER_PROMPTS) {
      expect(p.starter).toBe(true);
      expect(p.id.startsWith('starter:')).toBe(true);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(Array.from(p.title).length).toBeLessThanOrEqual(SAVED_PROMPT_LIMITS.title_chars);
      expect(Array.from(p.text).length).toBeLessThanOrEqual(SAVED_PROMPT_LIMITS.text_chars);
      expect(p.tools?.length).toBeGreaterThan(0);
      // A copy saved as the analyst's own must pass the stored-prompt rules.
      const copy = normaliseSavedPrompts([{ ...p, id: isPromptbook(p) ? newPromptId(true) : newPromptId() }]);
      expect(copy).toHaveLength(1);
    }
    expect(STARTER_PROMPTS.filter((p) => isPromptbook(p)).length).toBeGreaterThanOrEqual(3);
  });

  it('are offered only when every tool they need is allowed (fail closed)', () => {
    expect(visibleStarters(null)).toEqual([]);
    const all = visibleStarters(makeContext());
    expect(all.length).toBe(STARTER_PROMPTS.length);
    const noIntel = visibleStarters(makeContext({}, { lookup_indicator: 'enrichment:read' }));
    expect(noIntel.some((p) => p.tools?.includes('lookup_indicator'))).toBe(false);
    expect(noIntel.some((p) => p.id === 'starter:explain-case')).toBe(true);
  });
});

describe('search and order', () => {
  const prompts: ChatPrompt[] = [
    { id: 'a', title: 'VPN anomalies', text: 'Any odd VPN logins?', category: 'hunt' },
    { id: 'b', title: 'Phishing', text: 'Summarise phishing.', favorite: true, category: 'triage' },
    { id: 'c', title: 'Spend', text: 'AI spend today?' },
  ];

  it('puts favorites first and keeps the stored order otherwise', () => {
    expect(orderPrompts(prompts).map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by chip and by title, text or category name', () => {
    expect(filterPrompts(prompts, 'favorites', '').map((p) => p.id)).toEqual(['b']);
    expect(filterPrompts(prompts, 'hunt', '').map((p) => p.id)).toEqual(['a']);
    expect(filterPrompts(prompts, 'all', 'logins').map((p) => p.id)).toEqual(['a']);
    expect(filterPrompts(prompts, 'all', 'TRIAGE').map((p) => p.id)).toEqual(['b']);
    expect(matchesPrompt(prompts[2], '  ')).toBe(true);
    expect(CATEGORY_LABEL.app_help).toBe('App help');
  });
});
