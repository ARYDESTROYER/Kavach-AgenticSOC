/**
 * The Explain contract (Round 16 SPEC §4.3 WP01; research explainability §5.3).
 *
 * A builder in `./builders.ts` turns a number the Console shows into one typed
 * `Explanation`; the Explain kit (`@/design-system/explain`) only renders it. Every
 * value is plain text: an entity value, a rule name or a range is never markup (#9).
 * The numbers each builder prints are pinned, on both ends, by `./explain.contract.json`.
 * Type-only: zero runtime bytes.
 */

/** Where the numbers of an explanation came from. */
export type ExplanationProvenance =
  /** Recorded when the number was computed (for example a case's risk inputs). */
  | 'recorded'
  /** Re-derived now with today's settings, because the inputs were not recorded. */
  | 'reconstructed_current'
  /** Computed by the server for this reading. */
  | 'server_computed'
  /** Nothing recorded: the explanation says so instead of guessing. */
  | 'not_recorded';

/** One input of a calculation: its name, value, unit and where it came from. */
export interface ExplanationInput {
  key: string;
  label: string;
  value: string;
  source: string;
}

/** One arithmetic line of a calculation. */
export interface ExplanationStep {
  label: string;
  expression: string;
  result: string;
}

/** A link to the records behind a number (a Console route and its parameters). */
export interface ExplanationLink {
  label: string;
  route: string;
  params: Record<string, string>;
}

/** The explanation of one number, as the hover line and the click panel show it. */
export interface Explanation {
  /** What is explained: "risk_score", "priority", "mttr_p50" and so on. */
  metric: string;
  value: number | string | null;
  /** Exactly what the trigger shows. */
  display: string;
  /** The hover line, with the real numbers. */
  summary: string;
  /** The symbolic formula, for example "sum(w_i x f_i) / sum(w_i)". */
  formula: string;
  inputs: ExplanationInput[];
  steps: ExplanationStep[];
  /** How the shown value was rounded, for example "half up to an integer". */
  rounding?: string;
  provenance: ExplanationProvenance;
  /** Bounds, truncation and exclusions. */
  caveats: string[];
  link?: ExplanationLink;
}
