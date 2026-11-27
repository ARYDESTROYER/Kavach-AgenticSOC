/**
 * Match explanations in plain words (Round 14, SPEC §4.10.4): "Matched rule ssh_auth_failed
 * and technique T1110", the Fallback sentence, the tie sentence, and one sentence per
 * criterion a near miss failed ("Severity low is below medium").
 *
 * Mirrors `describe_explanation` in `backend/app/engine/runbook_match.py`, so the Why
 * attached summary, the match preview and audit rows say the same thing. Values in an
 * explanation come from case data (rule names, tags): they are returned as plain strings
 * for the caller to render as text nodes, never as markup (#9). Pure, no React.
 */
import type {
  MatchCriterion,
  MatchExplanation,
  MatchValue,
  MatchedCriterion,
  MissedCriterion,
  RunbookEntityType,
  RunbookVerdict,
} from '@/lib/types-runbooks';

import { CASE_STATUS_WORD, CRITERION_LABEL, ENTITY_TYPE_LABEL } from './labels';

const NOUNS: Partial<Record<MatchCriterion, [string, string]>> = {
  rule_ids: ['rule', 'rules'],
  mitre: ['technique', 'techniques'],
  entity_types: ['entity type', 'entity types'],
  sources: ['source', 'sources'],
  any_tags: ['tag', 'tags'],
};

const VERDICT_WORDS: Readonly<Record<RunbookVerdict, string>> = {
  TRUE_POSITIVE: 'true positive',
  FALSE_POSITIVE: 'false positive',
  NEEDS_HUMAN: 'needs a person',
};

/** "a", "a and b", "a, b and c". */
export function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function asList(value: MatchValue): string[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

function sourceWord(value: string): string {
  return value.startsWith('type:') ? `type ${value.slice(5)}` : value;
}

function verdictWord(value: string): string {
  return VERDICT_WORDS[value as RunbookVerdict] ?? value;
}

function statusWord(value: string): string {
  return (CASE_STATUS_WORD[value] ?? value.replace(/_/g, ' ')).toLowerCase();
}

/** One matched criterion in words: "rule ssh_auth_failed", "techniques T1110 and T1110.003". */
export function criterionWords(item: MatchedCriterion): string {
  const { criterion, value } = item;
  const nouns = NOUNS[criterion];
  if (nouns) {
    let values = asList(value);
    if (criterion === 'sources') values = values.map(sourceWord);
    return `${values.length === 1 ? nouns[0] : nouns[1]} ${joinWords(values)}`;
  }
  if (criterion === 'severity_at_least') return `severity ${String(value ?? '')}`;
  if (criterion === 'verdicts') return `verdict ${verdictWord(String(value ?? ''))}`;
  if (criterion === 'statuses') return `status ${statusWord(String(value ?? ''))}`;
  if (criterion === 'min_event_count') {
    const count = typeof value === 'number' ? value : Number(value) || 0;
    return `${count.toLocaleString()} events`;
  }
  return criterion;
}

/**
 * One sentence for an explanation: "Matched rule ssh_auth_failed and technique T1110.",
 * "Fallback: no other runbook matched this case.", with the tie sentence appended when
 * `tie` is set. `tied` is the number of runbooks that tied, when the caller knows it.
 */
export function describeExplanation(explanation: MatchExplanation | null | undefined, tied = 0): string {
  if (!explanation) return 'No runbook matched this case.';
  let text: string;
  if (explanation.tier === 0) {
    text = 'Fallback: no other runbook matched this case.';
  } else {
    const parts = explanation.matched.map(criterionWords);
    text = parts.length ? `Matched ${joinWords(parts)}.` : 'Matched.';
  }
  if (explanation.tie) {
    text +=
      tied >= 2
        ? ` ${tied.toLocaleString()} runbooks matched equally; the first by name was chosen.`
        : ' More than one runbook matched equally; the first by name was chosen.';
  }
  return text;
}

/** How specific a match is, in words (the four tiers of SPEC §4.10.4). */
export const TIER_LABEL: Readonly<Record<0 | 1 | 2 | 3, string>> = {
  3: 'Matched on a rule',
  2: 'Matched on a technique',
  1: 'Matched on other conditions',
  0: 'Fallback',
};

function expectedList(value: MatchValue, criterion: MatchCriterion): string {
  const values = asList(value).map((v) => {
    if (criterion === 'entity_types') return ENTITY_TYPE_LABEL[v as RunbookEntityType] ?? v;
    if (criterion === 'sources') return sourceWord(v);
    if (criterion === 'verdicts') return verdictWord(v);
    if (criterion === 'statuses') return statusWord(v);
    return v;
  });
  return values.length > 1 ? `one of ${joinWords(values)}` : values[0] ?? '';
}

/**
 * Why one criterion failed, as a plain sentence: "Severity low is below medium.",
 * "3 events is below 20.", "No User entity on the case.", "Rule web_auth is not listed."
 * An `actual` of `null` means the case does not know the value yet (before the verdict).
 */
export function missedSentence(item: MissedCriterion): string {
  const { criterion, expected, actual } = item;
  const label = CRITERION_LABEL[criterion];
  const wanted = expectedList(expected, criterion);
  if (criterion === 'entity_types') return `No ${wanted} entity on the case.`;
  if (actual === null || actual === undefined) {
    return `${label} is not known yet; this runbook needs ${wanted}.`;
  }
  if (Array.isArray(actual) && actual.length === 0) {
    return `The case has no ${label.toLowerCase()}; this runbook needs ${wanted}.`;
  }
  if (criterion === 'severity_at_least') return `Severity ${String(actual)} is below ${String(expected)}.`;
  if (criterion === 'min_event_count') {
    const have = typeof actual === 'number' ? actual : Number(actual) || 0;
    const need = typeof expected === 'number' ? expected : Number(expected) || 0;
    return `${countWord(have, 'event')} is below ${need.toLocaleString()}.`;
  }
  const have = asList(actual).map((v) =>
    criterion === 'sources' ? sourceWord(v) : criterion === 'verdicts' ? verdictWord(v) : criterion === 'statuses' ? statusWord(v) : v,
  );
  return `${label} ${joinWords(have)} is not ${wanted}.`;
}

function countWord(count: number, noun: string): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`;
}
