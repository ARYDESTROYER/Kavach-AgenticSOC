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

/** The whole explanation as plain text lines. */
export function explanationText(explanation: Explanation): string {
  const lines: string[] = [];
  lines.push(`${explanation.title ?? explanation.metric}: ${explanation.display}`);
  lines.push(explanation.summary);
  lines.push(`Formula: ${explanation.formula}`);
  if (explanation.inputs.length) {
    lines.push('Inputs:');
    for (const input of explanation.inputs) lines.push(`- ${input.label}: ${input.value} (${input.source})`);
  }
  if (explanation.steps.length) {
    lines.push('Steps:');
    for (const step of explanation.steps) lines.push(`- ${step.label}: ${step.expression} = ${step.result}`);
  }
  if (explanation.rounding) lines.push(`Rounding: ${explanation.rounding}`);
  lines.push(`Provenance: ${explanation.provenanceNote ?? PROVENANCE_WORDS[explanation.provenance]}`);
  for (const caveat of explanation.caveats) lines.push(`Note: ${caveat}`);
  return lines.join('\n');
}
