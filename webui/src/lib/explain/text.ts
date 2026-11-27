/**
 * An explanation as plain text, for the panel's "Copy calculation" (Round 16 SPEC §4.5
 * WP11; research explainability §5.1). Every value is copied as the text it is (#9).
 */
import type { Explanation, ExplanationProvenance } from './types';

/** The provenance in words, as the panel shows it. */
export const PROVENANCE_WORDS: Record<ExplanationProvenance, string> = {
  recorded: 'Recorded when the number was computed',
  reconstructed_current: "Reconstructed with today's settings",
  server_computed: 'Computed by the server for this reading',
  not_recorded: 'Not recorded',
};

/**
 * A summary's closing pointer to the full calculation ("Click for inputs.", "Select it to
 * compare them with the auto-close policy."). The hover line keeps it; the open panel and
 * the copied text drop it, because the reader is already there.
 */
const CLICK_HINT = /\s*(?:Click for [^.]*|Select it [^.]*)\.\s*$/;

/** True when a summary already ends by pointing at the full calculation. */
export function hasClickHint(summary: string): boolean {
  return CLICK_HINT.test(summary);
}

/** The summary without its closing pointer to the full calculation. */
export function summaryWithoutHint(summary: string): string {
  return summary.replace(CLICK_HINT, '');
}

/**
 * One step as copied text. A calculation reads "expression = result". A step written as a
 * sentence (it ends with a full stop, such as the risk Total "Recorded at scoring from the
 * unrounded factors. The stored factors give 20.82.") is not an equation, so its result
 * follows as "Result: 20.81", never "20.82. = 20.81".
 */
function stepText(expression: string, result: string): string {
  return /\.\s*$/.test(expression) ? `${expression} Result: ${result}` : `${expression} = ${result}`;
}

/** The whole explanation as plain text lines. */
export function explanationText(explanation: Explanation): string {
  const lines: string[] = [];
  lines.push(`${explanation.title ?? explanation.metric}: ${explanation.display}`);
  lines.push(summaryWithoutHint(explanation.summary));
  lines.push(`Formula: ${explanation.formula}`);
  if (explanation.inputs.length) {
    lines.push('Inputs:');
    for (const input of explanation.inputs) lines.push(`- ${input.label}: ${input.value} (${input.source})`);
  }
  if (explanation.steps.length) {
    lines.push('Steps:');
    for (const step of explanation.steps) lines.push(`- ${step.label}: ${stepText(step.expression, step.result)}`);
  }
  if (explanation.rounding) lines.push(`Rounding: ${explanation.rounding}`);
  lines.push(`Provenance: ${explanation.provenanceNote ?? PROVENANCE_WORDS[explanation.provenance]}`);
  for (const caveat of explanation.caveats) lines.push(`Note: ${caveat}`);
  return lines.join('\n');
}
