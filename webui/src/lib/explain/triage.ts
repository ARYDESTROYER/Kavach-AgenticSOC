/**
 * The priority and severity explanations (Round 16 SPEC §4.5 WP11; research
 * explainability R5, D9 and §3 side facts).
 *
 * Priority is `matrix[impact/urgency]`: impact from the asset's criticality, urgency from
 * the risk score (high when escalated). A risk-81 case on an uncatalogued asset reads P3,
 * which looks wrong until the lookup is shown. With the matrix off there is no priority,
 * and the explanation says so instead of showing the default level (D9).
 *
 * Severity is the source's own rating projected onto 0 to 100 against the source's
 * declared ceiling, or, when the source asserted none, derived from the risk score.
 *
 * Pure: plain data only; an entity value is a text value (#9). Advisory: never feeds
 * `decide()` (#3).
 */
import type { TriageChips } from '@/soc/pages/CaseDetail.api';

import { displayScore, trimmed } from './rounding';
import type { Explanation, ExplanationInput } from './types';

/** The three-band cuts shared by impact and urgency (contract `priority.band_cuts`). */
export const TRIAGE_BAND_CUTS = { high: 48, medium: 22 } as const;

/** The five-band severity ladder (`priority._severity_band_from_magnitude`). */
export const SEVERITY_CUTS = { critical: 74, high: 48, medium: 22, low: 8 } as const;

/** The three-band reading of a 0 to 100 magnitude. */
export function triageBand(value: number): 'high' | 'medium' | 'low' {
  if (value >= TRIAGE_BAND_CUTS.high) return 'high';
  if (value >= TRIAGE_BAND_CUTS.medium) return 'medium';
  return 'low';
}

/**
 * `value` printed with enough decimals that the printed number is in `band` by `bandOf`:
 * 47.996 in the medium band prints "47.996", never "48", which would read as high.
 */
function bandSafe(value: number, band: string, bandOf: (v: number) => string): string {
  for (let digits = 2; digits <= 6; digits += 1) {
    const text = trimmed(value, digits);
    if (bandOf(Number(text.replace(/,/g, ''))) === band) return text;
  }
  return trimmed(value, 6);
}

/**
 * The band's cut as a sentence that is true for the printed value. A value that is not a
 * whole number is never said to sit in "22 to 47": the medium band is "at least 22 and
 * under 48".
 */
function cutSentence(band: string, value: number, what: string, shown?: string): string {
  const v = shown ?? bandSafe(value, band, triageBand);
  if (band === 'high') return `${what} ${v} >= ${TRIAGE_BAND_CUTS.high}`;
  if (band === 'medium') return `${what} ${v} is at least ${TRIAGE_BAND_CUTS.medium} and under ${TRIAGE_BAND_CUTS.high}`;
  return `${what} ${v} < ${TRIAGE_BAND_CUTS.medium}`;
}

/**
 * The risk score as urgency reads it: the shown integer (rounded half up), the same
 * integer the risk chip bands, with the unrounded score beside it when they differ.
 */
function shownRisk(value: number, display: unknown): { shown: number; text: string } {
  const shown = finite(display) ?? displayScore(value) ?? 0;
  const text = shown === value ? String(shown) : `${shown} (${trimmed(value)} rounded half up)`;
  return { shown, text };
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The ITIL priority: impact by urgency through the priority matrix. */
export function explainPriority(chips: TriageChips | null | undefined): Explanation | null {
  const priority = chips?.priority;
  if (!priority) return null;
  const impact = String(priority.impact || chips?.impact?.band || '').toLowerCase();
  const urgency = String(priority.urgency?.band || '').toLowerCase();
  const enabled = priority.inputs?.matrix_enabled ?? (priority as { enabled?: boolean }).enabled;
  const criticality = finite(chips?.impact?.criticality) ?? finite(chips?.impact?.value) ?? 0;
  const entity = String(chips?.impact?.entity || chips?.impact?.inputs?.entity_value || '');
  const urgencyValue = finite(priority.urgency?.value) ?? 0;
  const escalated = priority.urgency?.escalated === true;
  // Urgency bands the shown risk integer (Round 16 D4, R7), so "Risk 48" High beside
  // the chip never reads "Urgency medium: Risk 47.74".
  const risk = shownRisk(urgencyValue, (priority.urgency as { display?: unknown } | undefined)?.display);

  const impactLine = `${cutSentence(impact, criticality, 'Asset criticality')}${
    entity ? ` for ${entity}` : ''
  }${criticality === 0 ? ' (no asset entry)' : ''}`;
  const urgencyLine = escalated && triageBand(risk.shown) !== 'high'
    ? `The case is escalated, so urgency is at least high (risk ${risk.text})`
    : cutSentence(urgency, risk.shown, 'Risk', risk.text);

  const inputs: ExplanationInput[] = [
    { key: 'impact', label: 'Impact', value: `${impact || 'unknown'}: ${impactLine}`, source: 'Asset criticality map' },
    { key: 'urgency', label: 'Urgency', value: `${urgency || 'unknown'}: ${urgencyLine}`, source: 'Risk score' },
  ];
  const base = {
    metric: 'priority',
    title: 'Priority',
    formula: 'priority = matrix[impact / urgency]',
    inputs,
    provenance: 'server_computed' as const,
    rounding: `Impact and urgency are high from ${TRIAGE_BAND_CUTS.high}, medium from ${TRIAGE_BAND_CUTS.medium}, otherwise low. Urgency reads the risk score as shown, rounded half up.`,
  };

  if (enabled === false || priority.level === null || priority.level === undefined) {
    return {
      ...base,
      value: null,
      display: 'No priority',
      summary: 'No priority: the priority matrix is off.',
      steps: [{ label: 'Priority matrix', expression: 'Off in Settings', result: 'No priority' }],
      caveats: ['Turn on the priority matrix to rank cases P1 to P4.'],
    };
  }
  const level = String(priority.level);
  const matched = priority.matched !== false;
  return {
    ...base,
    value: level,
    display: level,
    summary: `${level} = matrix[impact ${impact}, urgency ${urgency}]. Impact ${impact}: ${impactLine}. Urgency ${urgency}: ${urgencyLine}.`,
    steps: [
      { label: 'Impact', expression: impactLine, result: impact },
      { label: 'Urgency', expression: urgencyLine, result: urgency },
      {
        label: 'Lookup',
        expression: `matrix["${impact}/${urgency}"]`,
        result: matched ? level : `${level} (no entry; the default applies)`,
      },
    ],
    caveats: matched ? [] : [`The matrix has no entry for ${impact}/${urgency}, so the default ${priority.default} applies.`],
  };
}

const SEVERITY_WORDS: Record<string, string> = {
  critical: `Critical (${SEVERITY_CUTS.critical} to 100)`,
  high: `High (${SEVERITY_CUTS.high} to ${SEVERITY_CUTS.critical - 1})`,
  medium: `Medium (${SEVERITY_CUTS.medium} to ${SEVERITY_CUTS.high - 1})`,
  low: `Low (${SEVERITY_CUTS.low} to ${SEVERITY_CUTS.medium - 1})`,
  info: `Info (below ${SEVERITY_CUTS.low})`,
};

/** The same ladder for a value that is not a whole number (no "22 to 47" for 47.6). */
const SEVERITY_RANGE_WORDS: Record<string, string> = {
  critical: `Critical (at least ${SEVERITY_CUTS.critical})`,
  high: `High (at least ${SEVERITY_CUTS.high} and under ${SEVERITY_CUTS.critical})`,
  medium: `Medium (at least ${SEVERITY_CUTS.medium} and under ${SEVERITY_CUTS.high})`,
  low: `Low (at least ${SEVERITY_CUTS.low} and under ${SEVERITY_CUTS.medium})`,
  info: `Info (below ${SEVERITY_CUTS.low})`,
};

/** The five-band severity reading of a 0 to 100 magnitude. */
function severityBand(value: number): string {
  if (value >= SEVERITY_CUTS.critical) return 'critical';
  if (value >= SEVERITY_CUTS.high) return 'high';
  if (value >= SEVERITY_CUTS.medium) return 'medium';
  if (value >= SEVERITY_CUTS.low) return 'low';
  return 'info';
}

/** The severity chip: source-asserted or derived from the risk score. */
export function explainSeverity(chips: TriageChips | null | undefined): Explanation | null {
  const severity = chips?.severity;
  if (!severity) return null;
  const band = String(severity.band || '').toLowerCase();
  if (!band) return null;
  const value = finite(severity.value) ?? 0;
  const raw = finite(severity.raw);
  const scaleMax =
    finite((severity as { scale_max?: unknown }).scale_max) ?? finite((severity as { scale?: unknown }).scale) ?? 100;
  const source = String(severity.source || '');
  const word = band.charAt(0).toUpperCase() + band.slice(1);
  const display = `${word} severity`;
  const ladder = SEVERITY_WORDS[band] ?? word;

  if (source === 'derived' || raw === null) {
    // A derived severity bands the shown risk integer, as the risk chip does.
    const risk = shownRisk(value, (severity as { display?: unknown }).display);
    return {
      metric: 'severity',
      title: 'Severity',
      value: band,
      display,
      summary: `${word} severity: the source reported none, so it is derived from the risk score ${risk.text}, in the ${ladder} band.`,
      formula: 'band of the shown risk score when the source asserts no severity',
      inputs: [{ key: 'risk', label: 'Risk score', value: trimmed(value), source: 'The case' }],
      steps: [{ label: 'Band', expression: `risk ${risk.text}`, result: ladder }],
      provenance: 'server_computed',
      caveats: ['Severity rates the alert type; risk scores this case. Derived severity follows the risk score.'],
    };
  }
  const projected = Math.min(100, (raw / scaleMax) * 100);
  const projectedText = bandSafe(projected, band, severityBand);
  const projectedLadder = Number.isInteger(Number(projectedText.replace(/,/g, '')))
    ? ladder
    : SEVERITY_RANGE_WORDS[band] ?? ladder;
  const caveats: string[] = [];
  if (source === 'source_out_of_range') {
    caveats.push(
      `The source reported ${trimmed(raw)}, above its declared ceiling of ${trimmed(scaleMax)}, so the projection stops at 100. Declare the source's real ceiling to fix this.`,
    );
  }
  return {
    metric: 'severity',
    title: 'Severity',
    value: band,
    display,
    summary: `${word} severity: the source reported ${trimmed(raw)} on a 0 to ${trimmed(scaleMax)} scale; ${trimmed(raw)} / ${trimmed(scaleMax)} x 100 = ${projectedText}, in the ${projectedLadder} band.`,
    formula: 'min(100, source severity / scale ceiling x 100), then the severity band',
    inputs: [
      { key: 'raw', label: 'Source severity', value: trimmed(raw), source: 'Highest severity on the member events' },
      { key: 'scale_max', label: 'Scale ceiling', value: trimmed(scaleMax), source: "The source's declared ceiling" },
    ],
    steps: [
      { label: 'Projection', expression: `min(100, ${trimmed(raw)} / ${trimmed(scaleMax)} x 100)`, result: projectedText },
      { label: 'Band', expression: projectedText, result: projectedLadder },
    ],
    provenance: 'server_computed',
    caveats,
  };
}
