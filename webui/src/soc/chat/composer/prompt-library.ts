/**
 * The prompt library (Round 12 SPEC §3.1, SYNTHESIS-chat P1-8) as pure data + helpers.
 *
 * Two kinds of entries share one shape (`ChatPrompt`):
 *
 *   - the analyst's OWN prompts — `UserPrefs.chat_prompts` (≤ 50), each with an optional
 *     category and a favourite star (the stored field is `favorite`), edited through the
 *     existing prefs routes;
 *   - STARTER prompts shipped in code ({@link STARTER_PROMPTS}), read-only templates per
 *     category, offered only when every tool they need is allowed (fail closed, like the
 *     `/` commands). An analyst can save a copy and change it.
 *
 * `{name}` placeholders in a prompt's text are filled in by the composer before sending:
 * the values are the analyst's own words, substituted in ONE pass (a value that itself
 * contains `{x}` is never expanded again).
 *
 * Promptbooks — an ordered sequence of prompts run as consecutive turns — fit the
 * existing storage with no backend change: a saved prompt whose id starts with
 * {@link PROMPTBOOK_ID_PREFIX} holds its steps in `text`, separated by a line that has
 * only {@link PROMPTBOOK_SEPARATOR}. The whole book shares the 2,000-character text limit.
 */
import type { ChatContextInfo, ChatPrompt, ChatPromptCategory } from '@/lib/types';
import { toolsAllowed } from './commands';

/* -------------------------------------------------------------------------- */
/* Categories.                                                                 */
/* -------------------------------------------------------------------------- */

export const PROMPT_CATEGORIES: ReadonlyArray<{ id: ChatPromptCategory; label: string }> = [
  { id: 'triage', label: 'Triage' },
  { id: 'hunt', label: 'Hunt' },
  { id: 'ioc', label: 'IOC' },
  { id: 'posture', label: 'Posture' },
  { id: 'reporting', label: 'Reporting' },
  { id: 'app_help', label: 'App help' },
];

export const CATEGORY_LABEL: Readonly<Record<ChatPromptCategory, string>> = Object.fromEntries(
  PROMPT_CATEGORIES.map((c) => [c.id, c.label]),
) as Record<ChatPromptCategory, string>;

export function isPromptCategory(value: unknown): value is ChatPromptCategory {
  return typeof value === 'string' && PROMPT_CATEGORIES.some((c) => c.id === value);
}

/* -------------------------------------------------------------------------- */
/* Placeholders.                                                               */
/* -------------------------------------------------------------------------- */

/** `{name}`: a letter, then letters, digits, spaces, `_` or `-` (≤ 40 characters). */
const PARAM_RE = /\{([A-Za-z][A-Za-z0-9 _-]{0,39})\}/g;

/** A placeholder name as the analyst reads it: "case_id" → "Case id". */
export function paramLabel(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** The key two spellings of one placeholder share ("Case id" and "case_id"). */
export function paramKey(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The distinct placeholders of one or more texts, in first-seen order. */
export function promptParams(...texts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PARAM_RE)) {
      const key = paramKey(match[1]);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(match[1]);
    }
  }
  return out;
}

/**
 * Fill every placeholder with its value (keyed by {@link paramKey}) in one pass. A
 * placeholder without a value is left as written; a value is inserted verbatim (trimmed)
 * and never re-scanned.
 */
export function fillPrompt(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PARAM_RE, (whole, name: string) => {
    const value = values[paramKey(name)];
    return typeof value === 'string' && value.trim() ? value.trim() : whole;
  });
}

/* -------------------------------------------------------------------------- */
/* Promptbooks.                                                                */
/* -------------------------------------------------------------------------- */

/** A saved prompt whose id starts with this is a promptbook. */
export const PROMPTBOOK_ID_PREFIX = 'book-';
/** The line that separates two steps of a promptbook. */
export const PROMPTBOOK_SEPARATOR = '---';
export const MIN_PROMPTBOOK_STEPS = 2;
export const MAX_PROMPTBOOK_STEPS = 10;

export function isPromptbook(prompt: Pick<ChatPrompt, 'id'>): boolean {
  return prompt.id.startsWith(PROMPTBOOK_ID_PREFIX) || prompt.id.startsWith(`starter:${PROMPTBOOK_ID_PREFIX}`);
}

/** Every step of a text: split on lines that hold only `---` (or longer), empty steps dropped. */
function splitSteps(text: string): string[] {
  const steps: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-{3,}\s*$/.test(line)) {
      steps.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  steps.push(current.join('\n'));
  return steps.map((step) => step.trim()).filter(Boolean);
}

/** The steps of a promptbook's text (at most {@link MAX_PROMPTBOOK_STEPS}). */
export function promptbookSteps(text: string): string[] {
  return splitSteps(text).slice(0, MAX_PROMPTBOOK_STEPS);
}

/** Steps → the stored text. */
export function joinPromptbookSteps(steps: readonly string[]): string {
  return steps.map((step) => step.trim()).filter(Boolean).join(`\n${PROMPTBOOK_SEPARATOR}\n`);
}

/** Why a promptbook text cannot be saved, or null. */
export function promptbookProblem(text: string): string | null {
  const raw = splitSteps(text);
  if (raw.length < MIN_PROMPTBOOK_STEPS) {
    return `A promptbook needs at least ${MIN_PROMPTBOOK_STEPS} steps. Put ${PROMPTBOOK_SEPARATOR} on its own line between steps.`;
  }
  if (raw.length > MAX_PROMPTBOOK_STEPS) return `A promptbook can have at most ${MAX_PROMPTBOOK_STEPS} steps.`;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Ids.                                                                        */
/* -------------------------------------------------------------------------- */

/** A fresh saved-prompt id (backend `CHAT_PROMPT_ID_PATTERN`), a promptbook's prefixed. */
export function newPromptId(book = false): string {
  const random = Math.random().toString(36).slice(2, 10) || '0';
  return `${book ? PROMPTBOOK_ID_PREFIX : 'p-'}${Date.now().toString(36)}-${random}`;
}

/* -------------------------------------------------------------------------- */
/* Starter prompts (read-only, shipped in code).                               */
/* -------------------------------------------------------------------------- */

/** A library entry: a saved prompt, or a starter (with the tools it needs). */
export interface LibraryPrompt extends ChatPrompt {
  /** Shipped in code: read-only (Use, Save a copy). */
  starter?: boolean;
  /** Every tool the prompt needs (starters only; fail closed without a catalogue). */
  tools?: readonly string[];
}

const starter = (
  slug: string,
  category: ChatPromptCategory,
  title: string,
  text: string,
  tools: readonly string[],
): LibraryPrompt => ({ id: `starter:${slug}`, title, text, category, tools, starter: true });

const book = (
  slug: string,
  category: ChatPromptCategory,
  title: string,
  steps: readonly string[],
  tools: readonly string[],
): LibraryPrompt => starter(`${PROMPTBOOK_ID_PREFIX}${slug}`, category, title, joinPromptbookSteps(steps), tools);

export const STARTER_PROMPTS: readonly LibraryPrompt[] = [
  // Triage
  starter('needs-review', 'triage', 'Cases waiting for a person', 'List the open cases that need human review, oldest first, with their risk and why each one needs a person.', ['search_cases']),
  starter('top-risk', 'triage', 'Highest-risk open cases', 'Which open cases have the highest risk? Show the top 10 with their rule, severity and age.', ['search_cases']),
  starter('explain-case', 'triage', 'Explain a case', 'Investigate case {case id}: what happened, the evidence and why it was decided that way.', ['get_case']),
  book(
    'triage-case',
    'triage',
    'Triage a case',
    [
      'Investigate case {case id}: what happened and what evidence supports it.',
      'Do the hosts, users or indicators in case {case id} appear in other cases or in the last 7 days of logs?',
      'Create an investigation brief on case {case id} with these sections: Assessment, Key findings, Affected entities, ATT&CK, Next steps, What could not be checked.',
    ],
    ['get_case', 'search_cases', 'search_logs'],
  ),
  // Hunt
  starter('hunt-indicator', 'hunt', 'Hunt an indicator', 'Hunt for {indicator} across logs, cases and threat intel in the last {period}. What do we know about it?', ['search_logs']),
  starter('failed-sign-ins', 'hunt', 'Failed sign-ins for a user', 'Show failed sign-ins for {user} in the last 7 days: sources, hosts and times, and whether a sign-in succeeded afterwards.', ['search_logs']),
  starter('host-activity', 'hunt', 'Unusual activity on a host', 'What unusual activity has {host} shown in the last 24 hours compared with its usual pattern?', ['search_logs', 'log_stats']),
  // IOC
  starter('reputation', 'ioc', 'Indicator reputation', 'Look up the reputation of {indicator} and tell me where we have seen it.', ['lookup_indicator']),
  starter('indicator-cases', 'ioc', 'Cases that mention an indicator', 'Which cases mention {indicator}, and how were they decided?', ['search_cases']),
  starter('technique', 'ioc', 'Explain an ATT&CK technique', 'Explain ATT&CK technique {technique id} and whether our cases show it.', ['mitre_lookup']),
  book(
    'indicator-deep-dive',
    'ioc',
    'Indicator deep dive',
    [
      'Look up the reputation of {indicator}.',
      'Hunt for {indicator} in the logs from the last 30 days. Where and when did it appear?',
      'Which cases mention {indicator}, and how were they decided?',
    ],
    ['lookup_indicator', 'search_logs', 'search_cases'],
  ),
  // Posture
  starter('this-month', 'posture', 'This month against last month', 'How is the SOC doing this month compared with last month? Show case volume, the false-positive rate and response times.', ['case_stats', 'soc_metrics']),
  starter('noise', 'posture', 'Noise reduction', 'How much alert noise did automation remove in the last 30 days, and what reached a person?', ['soc_metrics']),
  starter('sources', 'posture', 'Silent or degraded sources', 'Which log sources are silent or degraded, and what is our coverage?', ['source_health']),
  // Reporting
  starter('monthly-report', 'reporting', 'Monthly SOC report', 'Create a monthly SOC report for {month} with these sections: Summary, Volume by week, Quality, Response times, Noise reduction, Top cases, Next steps.', ['case_stats', 'soc_metrics']),
  starter('executive-summary', 'reporting', 'Executive summary', 'Create an executive summary report for {period} with these sections: Summary, Volume, Quality, Response times, Noise reduction, Next steps.', ['case_stats', 'soc_metrics']),
  starter('shift-handoff', 'reporting', 'Shift handoff', 'Write a shift brief for the handoff: a summary, open work, key metrics and next steps.', ['shift_report']),
  book(
    'weekly-review',
    'reporting',
    'Weekly review',
    [
      'How did the SOC do last week compared with the week before? Show volume, the false-positive rate and response times.',
      'Which 5 rules created the most cases last week, and how were those cases decided?',
      'Create an executive summary report for last week with these sections: Summary, Volume, Quality, Response times, Next steps.',
    ],
    ['case_stats', 'soc_metrics', 'search_cases'],
  ),
  // App help
  starter('setting', 'app_help', 'What a setting does', 'What does the {setting} setting do in this console, and who can change it?', ['app_help']),
  starter('how-to', 'app_help', 'How do I…', 'How do I {task} in this console? Give me the steps.', ['app_help']),
  starter('metric', 'app_help', 'Explain a metric', 'What does the {metric} metric mean, and how is it calculated?', ['app_help']),
];

/** The starters this user can run: every tool allowed and switched on. */
export function visibleStarters(context: ChatContextInfo | null | undefined): LibraryPrompt[] {
  if (!context) return [];
  return STARTER_PROMPTS.filter((p) => toolsAllowed(context, p.tools ?? []));
}

/* -------------------------------------------------------------------------- */
/* Search and order.                                                           */
/* -------------------------------------------------------------------------- */

export type LibraryFilter = 'all' | 'favorites' | ChatPromptCategory;

/** Favourites first, then the stored order (stable). */
export function orderPrompts<T extends ChatPrompt>(prompts: readonly T[]): T[] {
  return prompts
    .map((prompt, index) => ({ prompt, index }))
    .sort((a, b) => Number(Boolean(b.prompt.favorite)) - Number(Boolean(a.prompt.favorite)) || a.index - b.index)
    .map(({ prompt }) => prompt);
}

/** Does a prompt match a free-text query (title, text or category name)? */
export function matchesPrompt(prompt: ChatPrompt, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const category = prompt.category ? CATEGORY_LABEL[prompt.category].toLowerCase() : '';
  return (
    prompt.title.toLowerCase().includes(needle) ||
    prompt.text.toLowerCase().includes(needle) ||
    (category !== '' && category.includes(needle))
  );
}

/**
 * Filter by the chip (all / favourites / a category) and the search text. A list of
 * categories (Round 13: a start-screen pill such as Hunt, which covers `hunt` and `ioc`)
 * keeps the prompts in any of them; an empty list keeps every prompt.
 */
export function filterPrompts<T extends ChatPrompt>(
  prompts: readonly T[],
  filter: LibraryFilter | readonly ChatPromptCategory[],
  query: string,
): T[] {
  return prompts.filter((prompt) => {
    if (Array.isArray(filter)) {
      if (filter.length && !(prompt.category && filter.includes(prompt.category))) return false;
      return matchesPrompt(prompt, query);
    }
    if (filter === 'favorites' && !prompt.favorite) return false;
    if (filter !== 'all' && filter !== 'favorites' && prompt.category !== filter) return false;
    return matchesPrompt(prompt, query);
  });
}

/** What a prompt asks for before it runs: its steps (a promptbook) and its placeholders. */
export interface PromptPlan {
  prompt: LibraryPrompt;
  /** One step for an ordinary prompt. */
  steps: string[];
  params: string[];
  book: boolean;
}

export function planPrompt(prompt: LibraryPrompt): PromptPlan {
  const book = isPromptbook(prompt);
  const steps = book ? promptbookSteps(prompt.text) : [prompt.text];
  return { prompt, steps, params: promptParams(...steps), book };
}

/** A plan with nothing to ask and one step: the text can go straight into the composer. */
export function planIsDirect(plan: PromptPlan): boolean {
  return !plan.book && plan.params.length === 0;
}
