/**
 * The case detail's tabs, in order: the one list the case workspace renders and the
 * router accepts in a Case Manager deep link (`#/case_manager?caseId=…&tab=investigation`).
 *
 * Entry-safe and import-free: the router validates the `tab` key with {@link isCaseTab}
 * in the entry chunk, and the lazy CaseDetail renders and indexes the same tuple
 * (Alt+1 to Alt+7 select the tabs in this order), so a tab added or renamed here is
 * accepted by the deep link and shown by the page at once.
 */
export const CASE_TABS = ['overview', 'runbook', 'timeline', 'investigation', 'threat', 'collab', 'chat'] as const;

export type CaseTab = (typeof CASE_TABS)[number];

/** True for a case tab id. */
export function isCaseTab(value: unknown): value is CaseTab {
  return typeof value === 'string' && (CASE_TABS as readonly string[]).includes(value);
}
