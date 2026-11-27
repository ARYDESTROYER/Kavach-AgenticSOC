/**
 * "Ask about this" topic ids (chat revamp SPEC §10.7, A7): the `console_map` topics a
 * KPI help popover or a Settings section header starts a chat with. The chat page
 * resolves the id to its server-templated question; no free text ever travels with it.
 *
 * Every id here must exist in `backend/app/knowledge/console_map.json` (pinned by
 * `ask-topics.contract.test.ts`); the map itself is generated from
 * `console-map.contract.test.ts` (KPI_TOPICS and the Settings sections).
 */

/** A `console_map` KPI topic id. */
export type KpiTopicId = `kpi:${string}`;

/** KPI tile anchors (Overview strip `testId`s and lifecycle keys) → their topic. */
export const KPI_TOPICS: Readonly<Record<string, KpiTopicId>> = {
  'active-risk-index': 'kpi:active_risk_index',
  'total-cases': 'kpi:total_cases',
  'total-critical': 'kpi:total_critical',
  'open-cases': 'kpi:open_cases',
  'false-positive-rate': 'kpi:false_positive_rate',
  'resolved-closed': 'kpi:resolved_closed',
  'auto-closed': 'kpi:auto_closed',
  'human-vs-ai': 'kpi:human_vs_ai',
  'noise-reduction': 'kpi:noise_reduction',
  mtta: 'kpi:mtta',
  mttr: 'kpi:mttr',
  dwell: 'kpi:dwell',
};

/** The topic a KPI anchor asks about, or `undefined` when it has none. */
export function kpiTopic(anchor: string | null | undefined): KpiTopicId | undefined {
  return anchor && Object.prototype.hasOwnProperty.call(KPI_TOPICS, anchor) ? KPI_TOPICS[anchor] : undefined;
}

/** The topic a Settings section header asks about (`settings:<section id>`). */
export function settingsTopic(sectionId: string): `settings:${string}` {
  return `settings:${sectionId}`;
}
