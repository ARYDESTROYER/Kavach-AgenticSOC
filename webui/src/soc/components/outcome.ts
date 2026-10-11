/**
 * caseOutcome — the ONE answer to "what was this case?" for every case surface
 * (Round 12, SPEC D15 / SYNTHESIS-ux §3.1).
 *
 * Three axes, never conflated:
 *   - STATUS answers "where is the work?" (lifecycle; glyph + text, no fill);
 *   - the ANALYST CLASSIFICATION answers "what was it?" (filled disposition badge with
 *     an `Analyst` provenance tag) — once a human classifies, it is the headline;
 *   - the AI VERDICT answers "what did the machine think?" — always kept, as a labelled
 *     secondary line ("AI verdict: Needs human review (75%)").
 *
 * The classification gate mirrors the backend ground-truth authority EXACTLY
 * (`backend/app/engine/analyst_outcomes.py` `_confirmation` + `is_classification_entry`):
 * a disposition counts as the analyst's only when `decision_by === 'analyst'` AND the
 * case history carries an explicit classification entry — an `analyst_action` whose
 * action is `set_disposition`/`confirm_fp`, or one stamped with a non-empty
 * `classified_disposition` (a declared close/resolve). The disposition VALUE alone is
 * never evidence: `case_manager.apply()` derives one from the model's verdict at triage,
 * and an undeclared close may echo it back, so a model-derived `true_positive` must never
 * render as the analyst's call.
 *
 * Pure, presentation-only (#3): nothing here decides, mutates or calls `decide()`.
 * Every string it returns is fixed, controlled copy built from enum tokens (#9) —
 * the analyst name (`by`) is returned as data for the caller to render as plain text.
 */
import type { Case, Disposition } from '@/lib/types';
import { humanizeToken } from '@/lib/format';

/** Who settled the case outcome, in precedence order (first match wins). */
export type OutcomeSource =
  /** A human classified the case (the gate above). */
  | 'analyst'
  /** An operator's declared-benign policy closed it with no model call. */
  | 'analyst_policy'
  /** A human closed/resolved it WITHOUT recording a classification. */
  | 'analyst_unrecorded'
  /** The deterministic auto-close policy closed it on the AI verdict. */
  | 'agent_auto'
  /** Still open, or routed by the system: the AI assessment is all there is. */
  | 'pending';

/**
 * How the analyst's classification relates to the AI verdict. `resolved` is the
 * NEEDS_HUMAN case: the model handed the call to a person, so a concrete outcome
 * RESOLVES it rather than overriding it (it must never count as a disagreement).
 */
export type OutcomeAgreement = 'agrees' | 'overrides' | 'resolved' | null;

export interface CaseOutcome {
  source: OutcomeSource;
  /** The analyst's disposition — set only when `source === 'analyst'`. */
  disposition: Disposition | null;
  /** The analyst who classified (from the classification history entry). PLAIN DATA. */
  by?: string;
  /** When the classification was recorded (ISO, from the history entry). */
  at?: string;
  /** The canonical AI verdict (`TRUE_POSITIVE` / `FALSE_POSITIVE` / `NEEDS_HUMAN`) or null. */
  aiVerdict: string | null;
  /** The AI confidence as a 0..100 percentage, or null. */
  aiConfidence: number | null;
  agreement: OutcomeAgreement;
  /** Terminal lifecycle status (closed / resolved). */
  terminal: boolean;
  /** The sentence-case headline for this case (controlled copy). */
  headline: string;
  /** "AI verdict: Needs human review (75%)" — null when there is no verdict to cite. */
  aiLine: string | null;
  /** A compact outcome word for rows, chips and table cells. */
  shortLabel: string;
}

const TERMINAL = new Set(['closed', 'resolved']);
const CLASSIFICATION_ACTIONS = new Set(['set_disposition', 'confirm_fp']);
const CLASSIFIED_DISPOSITION_KEY = 'classified_disposition';

/** Disposition values that agree with each AI verdict (the grading map, §A.10). */
const VERDICT_MATCH: Record<string, readonly string[]> = {
  TRUE_POSITIVE: ['true_positive'],
  FALSE_POSITIVE: ['false_positive', 'benign'],
  NEEDS_HUMAN: ['suspicious', 'undetermined'],
};
/** A concrete outcome — the values that RESOLVE a NEEDS_HUMAN hand-off. */
const CONCRETE_DISPOSITIONS = new Set(['true_positive', 'false_positive', 'benign']);

const lower = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/** True for a terminal lifecycle status (`closed` / `resolved`). */
export function isTerminalStatus(status: unknown): boolean {
  return TERMINAL.has(lower(status));
}

/** Canonical upper-case verdict token, or null for none/unknown. */
export function canonicalVerdict(verdict: unknown): string | null {
  const v = typeof verdict === 'string' ? verdict.trim().toUpperCase().replace(/[\s-]+/g, '_') : '';
  if (!v || v === 'NONE') return null;
  return v;
}

/** Sentence-case words for an AI verdict ("Needs human review"). */
export function verdictWords(verdict: unknown): string {
  const v = canonicalVerdict(verdict);
  if (!v) return 'Not yet assessed';
  if (v === 'TRUE_POSITIVE') return 'True positive';
  if (v === 'FALSE_POSITIVE') return 'False positive';
  if (v === 'NEEDS_HUMAN') return 'Needs human review';
  return humanizeToken(v.toLowerCase());
}

/** Sentence-case label for a disposition ("False positive"). */
export function dispositionWords(disposition: unknown): string {
  const d = lower(disposition);
  if (!d || d === 'none') return 'Undetermined';
  return humanizeToken(d);
}

/** Confidence (0..1 or 0..100) as a rounded 0..100 percentage, or null. */
export function confidencePercent(confidence: unknown): number | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

/** One recorded analyst classification, newest first — or null when there is none. */
export interface ClassificationEntry {
  disposition: string | null;
  by?: string;
  at?: string;
  action: string;
}

/**
 * The newest EXPLICIT classification entry in `c.history` (the backend's
 * `is_classification_entry`), or null. Exported for the facts rail and audit view.
 */
export function classificationEntry(c: Pick<Case, 'history'> | Case): ClassificationEntry | null {
  const history = (c as { history?: unknown }).history;
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || entry.event !== 'analyst_action') continue;
    const action = typeof entry.action === 'string' ? entry.action : '';
    const declared =
      typeof entry[CLASSIFIED_DISPOSITION_KEY] === 'string'
        ? (entry[CLASSIFIED_DISPOSITION_KEY] as string).trim()
        : '';
    if (!CLASSIFICATION_ACTIONS.has(action) && !declared) continue;
    return {
      disposition: declared || (action === 'confirm_fp' ? 'false_positive' : null),
      by: typeof entry.analyst === 'string' && entry.analyst.trim() ? entry.analyst : undefined,
      at: typeof entry.ts === 'string' && entry.ts.trim() ? entry.ts : undefined,
      action,
    };
  }
  return null;
}

/** Relationship between an analyst's disposition and the AI verdict. */
export function outcomeAgreement(verdict: unknown, disposition: unknown): OutcomeAgreement {
  const v = canonicalVerdict(verdict);
  const d = lower(disposition);
  if (!v || !d || d === 'duplicate') return null;
  const allowed = VERDICT_MATCH[v];
  if (!allowed) return null;
  if (allowed.includes(d)) return 'agrees';
  if (v === 'NEEDS_HUMAN' && CONCRETE_DISPOSITIONS.has(d)) return 'resolved';
  return 'overrides';
}

/** "Closed as false positive" / "Resolved as benign" / "Classified as suspicious — on hold". */
function classifiedHeadline(disposition: string, status: string): string {
  const words = dispositionWords(disposition).toLowerCase();
  if (status === 'closed') return `Closed as ${words}`;
  if (status === 'resolved') return `Resolved as ${words}`;
  const tail = statusTail(status);
  return tail ? `Classified as ${words} — ${tail}` : `Classified as ${words}`;
}

function statusTail(status: string): string {
  if (status === 'needs_human') return 'awaiting analyst';
  if (status === 'escalated') return 'escalated';
  if (status === 'on_hold') return 'on hold';
  if (status === 'investigating') return 'investigating';
  if (status === 'resolved') return 'resolved';
  if (status === 'closed') return 'closed';
  return '';
}

/**
 * The AI-led headline (unchanged from the pre-Round-12 decision brief): the verdict
 * read plus the lifecycle tail, de-duplicated when both say the same thing.
 */
export function aiHeadline(verdict: unknown, status: unknown): string {
  const v = lower(verdict);
  const s = lower(status);
  let lead: string;
  if (!v || v === 'none') lead = 'Not yet verdicted';
  else if (v === 'true_positive') lead = 'Likely a true positive';
  else if (v === 'false_positive') lead = 'Likely a false positive';
  else if (v === 'benign') lead = 'Assessed benign';
  else if (v === 'needs_human') lead = 'Needs human review';
  else if (v === 'suspicious') lead = 'Suspicious activity';
  else lead = humanizeToken(String(verdict));
  let tail = '';
  if (s === 'needs_human') tail = 'needs human review';
  else if (s === 'escalated') tail = 'escalated';
  else if (s === 'on_hold') tail = 'on hold';
  else if (s === 'resolved') tail = 'resolved';
  else if (s === 'closed') tail = 'closed';
  const canonical = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  if (!tail || v === s || canonical(lead) === canonical(tail)) return lead;
  return `${lead} — ${tail}`;
}

/** "AI verdict: Needs human review (75%)" — null when there is no verdict. */
export function aiVerdictLine(verdict: unknown, confidence: unknown): string | null {
  if (!canonicalVerdict(verdict)) return null;
  const pct = confidencePercent(confidence);
  return `AI verdict: ${verdictWords(verdict)}${pct === null ? '' : ` (${pct}%)`}`;
}

/** Compact AI verdict for a row ("AI: Needs human", "AI: True positive 90%"). */
function aiShortLabel(verdict: unknown, confidence: unknown): string {
  const v = canonicalVerdict(verdict);
  if (!v) return 'Not yet assessed';
  const word = v === 'NEEDS_HUMAN' ? 'Needs human' : verdictWords(v);
  const pct = confidencePercent(confidence);
  return v === 'NEEDS_HUMAN' || pct === null ? `AI: ${word}` : `AI: ${word} ${pct}%`;
}

/**
 * The outcome of record for a case, by the D15 precedence (first match wins):
 *   1. analyst            — `decision_by === 'analyst'` + a classification entry;
 *   2. analyst_policy     — `decision_by === 'analyst_policy'`;
 *   3. analyst_unrecorded — terminal, `decision_by === 'analyst'`, no classification;
 *   4. agent_auto         — terminal, `decision_by === 'agent'` (AI auto-close);
 *   5. pending            — everything else: the AI assessment, attributed as such.
 */
export function caseOutcome(c: Case): CaseOutcome {
  const status = lower(c.status);
  const decisionBy = lower(c.decision_by);
  const terminal = TERMINAL.has(status);
  const aiVerdict = canonicalVerdict(c.verdict);
  const aiConfidence = confidencePercent(c.confidence);
  const aiLine = aiVerdictLine(c.verdict, c.confidence);
  const base = { aiVerdict, aiConfidence, terminal, aiLine };

  if (decisionBy === 'analyst') {
    const entry = classificationEntry(c);
    if (entry) {
      // The backend reads the CASE's disposition once the gate is met; fall back to
      // the entry's declared value only when the field is absent.
      const stored = lower(c.disposition);
      const disposition = (stored && stored !== 'none' ? stored : entry.disposition) || null;
      return {
        ...base,
        source: 'analyst',
        disposition,
        by: entry.by,
        at: entry.at,
        agreement: outcomeAgreement(c.verdict, disposition),
        headline: disposition
          ? classifiedHeadline(disposition, status)
          : 'Classified by an analyst',
        shortLabel: disposition ? dispositionWords(disposition) : 'Classified',
      };
    }
  }
  if (decisionBy === 'analyst_policy') {
    return {
      ...base,
      source: 'analyst_policy',
      disposition: null,
      agreement: null,
      headline: terminal
        ? 'Closed by analyst policy (declared benign)'
        : 'Routed by analyst policy (declared benign)',
      shortLabel: 'Declared benign',
    };
  }
  if (terminal && decisionBy === 'analyst') {
    return {
      ...base,
      source: 'analyst_unrecorded',
      disposition: null,
      agreement: null,
      headline:
        status === 'resolved'
          ? 'Resolved by analyst: outcome not recorded'
          : 'Closed by analyst: outcome not recorded',
      shortLabel: 'Outcome not recorded',
    };
  }
  if (terminal && decisionBy === 'agent') {
    const lead =
      aiVerdict === 'FALSE_POSITIVE'
        ? 'Auto-closed as false positive'
        : aiVerdict === 'TRUE_POSITIVE'
          ? 'Auto-closed as true positive'
          : 'Auto-closed';
    return {
      ...base,
      source: 'agent_auto',
      disposition: null,
      agreement: null,
      headline: lead,
      shortLabel: 'Auto-closed',
    };
  }
  return {
    ...base,
    source: 'pending',
    disposition: null,
    agreement: null,
    headline: aiHeadline(c.verdict, c.status),
    shortLabel: aiShortLabel(c.verdict, c.confidence),
  };
}

/** True when a human has settled the outcome (analyst classification or policy). */
export function isHumanSettled(outcome: CaseOutcome): boolean {
  return outcome.source === 'analyst' || outcome.source === 'analyst_policy';
}

/** True when the case is terminal and the last lifecycle move was a person's. */
export function isHumanClosed(c: Case): boolean {
  const decisionBy = lower(c.decision_by);
  return isTerminalStatus(c.status) && (decisionBy === 'analyst' || decisionBy === 'analyst_policy');
}

/** Words for the agreement marker ("Agrees with the AI", "Overrides the AI", …). */
export function agreementWords(agreement: OutcomeAgreement): string | null {
  if (agreement === 'agrees') return 'Agrees with the AI';
  if (agreement === 'overrides') return 'Overrides the AI';
  if (agreement === 'resolved') return 'Resolves the AI hand-off';
  return null;
}
