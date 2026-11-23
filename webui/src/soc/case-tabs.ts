/**
 * The case detail's tabs, in order: the one list the case workspace renders and the
 * router accepts in a Case Manager deep link (`#/case_manager?caseId=…&tab=investigation`).
 *
 * Entry-safe and import-free: the router validates the `tab` key with {@link isCaseTab}
 * in the entry chunk, and the lazy CaseDetail renders and indexes the same tuple
 * (Alt+1 to Alt+5 select the tabs in this order), so a tab added or renamed here is
 * accepted by the deep link and shown by the page at once.
 *
 * Round 15 (SPEC D8.3): five tabs. The former Timeline tab is the Overview's "What
 * happened" section and the former Threat context tab is a section of Investigation.
 * Their ids stay valid in a link ({@link LEGACY_CASE_TABS}): the router rewrites one to
 * its new tab and asks the case to scroll to the section it became.
 */
export const CASE_TABS = ['overview', 'runbook', 'investigation', 'collab', 'chat'] as const;

export type CaseTab = (typeof CASE_TABS)[number];

/** True for a case tab id. */
export function isCaseTab(value: unknown): value is CaseTab {
  return typeof value === 'string' && (CASE_TABS as readonly string[]).includes(value);
}

/** A retired tab id, the tab it became and the section it is on that tab. */
export const LEGACY_CASE_TABS: Readonly<Record<string, readonly [CaseTab, string]>> = {
  timeline: ['overview', 'what-happened'],
  threat: ['investigation', 'threat-context'],
};
