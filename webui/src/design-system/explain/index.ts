/**
 * `@/design-system/explain`: the Explain kit (Round 16 SPEC §4.5 WP11).
 *
 * Hover a number for a one-line formula with the real numbers; click, Enter, Space or tap
 * for the full arithmetic. A separate entry, never re-exported from the `@/design-system`
 * barrel, so it stays out of the entry bundle: import it only from lazy route chunks.
 */
export { ExplainTrigger, type ExplainTriggerMode, type ExplainTriggerProps } from './ExplainTrigger';
export { ExplainPanel, explainLinkHref, type ExplainPanelProps } from './ExplainPanel';
