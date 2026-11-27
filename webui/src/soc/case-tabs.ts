/**
 * The case detail's tabs, in order: the one list the case workspace renders and the
 * router accepts in a Case Manager deep link (`#/case_manager?caseId=…&tab=investigation`).
 *
 * Entry-safe and import-free: the router validates the `tab` key with {@link isCaseTab}
 * in the entry chunk, and the lazy CaseDetail renders and indexes the same tuple
 * (Alt+1 to Alt+6 select the tabs in this order), so a tab added or renamed here is
 * accepted by the deep link and shown by the page at once.
 *
 * Round 16 (SPEC D8): six tabs, one lane each. Brief (`overview`), Evidence
 * (`evidence`), AI investigation (`investigation`), Response (`runbook`), Activity
 * (`collab`) and Chat (`chat`). The ids that links already use are kept. The retired
 * Timeline and Threat context tabs, and the sections that moved to Evidence, stay valid
 * in a link ({@link LEGACY_CASE_TABS}, {@link CASE_SECTION_TABS}): the router rewrites
 * one to the tab it is on now and asks the case to scroll to the section.
 */
export const CASE_TABS = ['overview', 'evidence', 'investigation', 'runbook', 'collab', 'chat'] as const;

export type CaseTab = (typeof CASE_TABS)[number];

/** True for a case tab id. */
export function isCaseTab(value: unknown): value is CaseTab {
  return typeof value === 'string' && (CASE_TABS as readonly string[]).includes(value);
}

/** A retired tab id, the tab it became and the section it is on that tab. */
export const LEGACY_CASE_TABS: Readonly<Record<string, readonly [CaseTab, string]>> = {
  timeline: ['evidence', 'what-happened'],
  threat: ['evidence', 'threat-context'],
};

/**
 * The sections a link can ask the case to scroll to, and the tab each is on. A closed
 * set, so a value from an address never reaches a selector. All three live on Evidence
 * since Round 16; a link that still names the tab they were on (`tab=investigation`
 * with `section=threat-context`, or any tab with `section=related-cases`) opens Evidence.
 */
export const CASE_SECTION_TABS: Readonly<Record<string, CaseTab>> = {
  'what-happened': 'evidence',
  'threat-context': 'evidence',
  'related-cases': 'evidence',
};
