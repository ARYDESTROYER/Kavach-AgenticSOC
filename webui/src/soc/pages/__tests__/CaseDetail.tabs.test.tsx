/**
 * CaseDetail: the five-tab story shell (Round 15, SPEC D8.3; Round 14 added the Runbook
 * tab second, SPEC §4.10.11).
 *
 *     overview · runbook · investigation · collab · chat
 *
 *   - "Overview" holds the AI summary and, as its "What happened" section, the six-stage
 *     narrative that was the Timeline tab (<TimelinePanel>); its stages load when Overview
 *     opens.
 *   - "Investigation" holds the AI assessment, the decision card and the trace
 *     (<InvestigationPanel>), and, as its "Threat context" section, what was the Threat
 *     context tab (<ThreatContextPanel>); threat context loads when Investigation opens.
 *
 * A link to a retired tab id (`timeline`, `threat`) is rewritten by the router to the tab
 * it became with the section to scroll to (router-case-tabs.round15.test.tsx, and the
 * mounted CaseDetail.requested-tab.test.tsx). The standalone Feedback tab stays retired.
 * This spec pins, as STATIC assertions on the orchestrator source (the load-bearing tab
 * wiring), not a full mount:
 *
 *   1. The `tab` union is EXACTLY the five tabs; the removed values are gone.
 *   2. Exactly five <TabsTrigger> on the underline list, each `value` matching its label,
 *      in order, with Alt+1 to Alt+5.
 *   3. Each <TabsContent> renders the RIGHT panel; the merged sub-panels (StageTimeline /
 *      WhyPanel / TraceTimeline) and the retired FeedbackTab are NOT mounted in the shell.
 *   4. The stage timeline and the threat context are passed INTO the Overview and the
 *      Investigation panels (`whatHappened`, `threatContext`), which render them as the
 *      `data-section` the router's rewrite scrolls to (OverviewPanel.test.tsx and
 *      InvestigationPanel.test.tsx pin the sections, and the mounted
 *      CaseDetail.requested-tab.test.tsx the scroll).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CASE_TABS, isCaseTab } from '@/soc/case-tabs';

const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');

/** Slice from the first occurrence of `needle` to the next `end` (exclusive). */
function slice(text: string, needle: string, end: string): string {
  const i = text.indexOf(needle);
  expect(i, `expected to find "${needle}"`).toBeGreaterThan(-1);
  const j = text.indexOf(end, i + needle.length);
  return text.slice(i, j === -1 ? text.length : j);
}

const TAB_VALUES = ['overview', 'runbook', 'investigation', 'collab', 'chat'] as const;
const REMOVED_TABS = ['why', 'trace', 'feedback', 'timeline', 'threat'] as const;

/** value → expected human label + the panel component(s) mounted for it. */
const TAB_LABEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'Overview',
  runbook: 'Runbook',
  investigation: 'Investigation',
  collab: 'Collaboration',
  chat: 'Chat',
};
const TAB_PANELS: Record<(typeof TAB_VALUES)[number], readonly string[]> = {
  overview: ['OverviewPanel', 'TimelinePanel'],
  runbook: ['RunbookPanel'],
  investigation: ['InvestigationPanel', 'ThreatContextPanel'],
  collab: ['CollaborationThreadTab'],
  chat: ['ChatTab'],
};

describe('CaseDetail: the five-tab story shell (Round 15, D8.3)', () => {
  it('the tab union is exactly the five tabs (the removed panels are gone)', () => {
    // Overview by default; a link's tab (Case Manager's `tab` key, closing QA integ-06)
    // opens first, validated against the union below.
    expect(src).toContain("requestedTab && requestedTab !== 'runbook' ? requestedTab : 'overview'");
    expect(src).toContain('const requestedTab = isCaseTab(requestedTabId) ? requestedTabId : null;');
    // The page reads the ONE tab list the router's `tab` key also validates against
    // (closing review: a hand-written router copy could drift); it defines none itself.
    expect(src).toContain("import { CASE_TABS, isCaseTab, type CaseTab } from '@/soc/case-tabs';");
    expect(src).not.toMatch(/const CASE_TABS\b/);
    expect(src).not.toMatch(/function isCaseTab\b/);
    expect([...CASE_TABS]).toEqual([...TAB_VALUES]);
    for (const v of TAB_VALUES) expect(isCaseTab(v)).toBe(true);
    for (const v of REMOVED_TABS) {
      expect(CASE_TABS as readonly string[], `union should NOT include the removed '${v}'`).not.toContain(v);
      expect(isCaseTab(v)).toBe(false);
    }
    for (const v of ['', 'Overview', 'investigation ', 'toString', 'constructor', null, 3]) {
      expect(isCaseTab(v)).toBe(false);
    }
  });

  it('renders exactly five underline TabsTrigger, each value matching its human label', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    // Record sections are underline tabs (ui-standard Page anatomy 6; D8.5).
    expect(tabsList).toContain('<TabsList variant="underline"');
    const triggers = tabsList.match(/<TabsTrigger\s+value="[^"]+"/g) || [];
    expect(triggers.length).toBe(5);
    expect(triggers.map((t) => /value="([^"]+)"/.exec(t)?.[1])).toEqual([...TAB_VALUES]);
    // Alt+1 to Alt+5 follow the tab order (the keyboard handler indexes CASE_TABS).
    const keys = tabsList.match(/aria-keyshortcuts="Alt\+(\d)"/g) || [];
    expect(keys).toEqual(TAB_VALUES.map((_, i) => `aria-keyshortcuts="Alt+${i + 1}"`));
    expect(src).toContain('/^Digit([1-5])$/');

    for (const v of TAB_VALUES) {
      const trigger = slice(tabsList, `value="${v}"`, 'TabsTrigger>');
      expect(trigger, `trigger '${v}' should be labeled "${TAB_LABEL[v]}"`).toContain(TAB_LABEL[v]);
    }
    for (const v of REMOVED_TABS) {
      expect(tabsList).not.toContain(`value="${v}"`);
    }
    // The hand-rolled 12px trigger classes are gone with the shared underline grammar.
    expect(src).not.toContain('EMBEDDED_TAB_TRIGGER');
  });

  it('each TabsContent mounts its panels, and each panel has ONE mount site', () => {
    for (const v of TAB_VALUES) {
      const content = slice(src, `<TabsContent value="${v}"`, '</TabsContent>');
      for (const panel of TAB_PANELS[v]) {
        expect(content, `TabsContent '${v}' should mount <${panel}>`).toContain(`<${panel}`);
      }
    }
    for (const comp of Object.values(TAB_PANELS).flat()) {
      expect((src.match(new RegExp(`<${comp}\\b`, 'g')) || []).length).toBe(1);
    }
    for (const v of REMOVED_TABS) {
      expect(src).not.toContain(`<TabsContent value="${v}"`);
    }
  });

  it('the merged sub-panels + retired Feedback tab are not mounted in the shell', () => {
    for (const gone of ['StageTimeline', 'WhyPanel', 'TraceTimeline', 'FeedbackTab']) {
      expect(src, `${gone} must not be referenced by the shell`).not.toContain(gone);
    }
  });

  it('Overview carries the "What happened" story with the stages state + retry', () => {
    const content = slice(src, '<TabsContent value="overview"', '</TabsContent>');
    // The stage story is the Overview's `whatHappened` section (rendered between the
    // summary and the key entities, D8.3).
    const section = slice(content, 'whatHappened={', 'runbookCard={');
    expect(section).toContain('<TimelinePanel');
    for (const prop of ['stages={stages}', 'onRetryStages={loadStages}']) {
      expect(section, `the What happened story should receive ${prop}`).toContain(prop);
    }
    // Its stage CTA still jumps to the Investigation tab.
    expect(section).toContain("onOpenInvestigation={() => setTab('investigation')}");
    // The Overview reads the model's reasoning for its summary (G17).
    expect(content).toContain('rationale={rationale}');
  });

  it('Investigation carries the rationale/timeline state and the "Threat context" section', () => {
    const content = slice(src, '<TabsContent value="investigation"', '</TabsContent>');
    for (const prop of [
      'rationale={rationale}',
      'onRetryRationale={loadRationale}',
      'timeline={timeline}',
      'onRetryTimeline={loadTimeline}',
    ]) {
      expect(content, `investigation panel should receive ${prop}`).toContain(prop);
    }
    expect(content).not.toContain('stages={stages}');
    // The threat context is the Investigation's `threatContext` section (D8.3).
    const section = slice(content, 'threatContext={', '</TabPanelMotion>');
    expect(section).toContain('<ThreatContextPanel');
    expect(section).toContain('panel={threat}');
    expect(section).toContain('onRetry={loadThreat}');
    // The decision's auto-close reading needs the FP policy.
    expect(content).toContain('fpPolicy={fpPolicy}');
  });

  it('renders every panel in its one Case Manager layout, with no presentation to choose', () => {
    // Round 12 converged the sheet host on the Case Manager design; Round 15 (D8.7) removed
    // the panels' unused 'default' layout, so no tab passes a presentation any more. The
    // Runbook panel takes the shared panel padding.
    const runbook = slice(src, '<TabsContent value="runbook"', '</TabsContent>');
    expect(runbook).toContain('className={CASE_MANAGER_PANEL_PADDING}');
    for (const value of TAB_VALUES) {
      const content = slice(src, `<TabsContent value="${value}"`, '</TabsContent>');
      expect(content, `TabsContent '${value}' passes no panel presentation`).not.toContain('presentation=');
    }
  });

  it('gives only the embedded Chat tab the full-height, internally-scrolling lane', () => {
    const scrollLane = slice(src, 'ref={panelScrollRef}', '<TabsContent value="overview"');
    expect(scrollLane).toContain("tab === 'chat' ? 'overflow-hidden' : 'overflow-y-auto'");

    const chat = slice(src, '<TabsContent value="chat"', '</TabsContent>');
    expect(chat).toContain('h-full min-h-0');

    for (const value of TAB_VALUES.filter((value) => value !== 'chat')) {
      const content = slice(src, `<TabsContent value="${value}"`, '</TabsContent>');
      expect(content).not.toContain('h-full min-h-0');
    }
  });

  it('stages lazy-load on Overview, threat context on Investigation, rationale for both and embedded', () => {
    expect(src).toContain("tab === 'overview' && stages === null && !stagesLoading && !stagesError");
    expect(src).toContain("tab === 'investigation' && threat === null && !threatLoading && !threatError");
    // The Overview's summary and the Investigation's assessment both read the reasoning.
    expect(src).toContain(
      "const needsRationale = tab === 'investigation' || tab === 'overview' || presentation === 'embedded'",
    );
    expect(src).toContain('needsRationale && rationale === null && !rationaleLoading && !rationaleError');
    expect(src).toContain("tab === 'investigation' && timeline === null && !timelineLoading && !timelineError");
    // No lingering effect keyed on a removed tab value.
    for (const v of REMOVED_TABS) {
      expect(src).not.toContain(`tab === '${v}'`);
    }
  });

  it('the header keeps the ONE outcome badge and the facts rail its auto-close deadline', () => {
    // Round 12 (D15): the header meta row carries the ONE outcome badge, which says
    // "Auto-closed" for an AI auto-close; Round 15 (D8.2) shows it in place of the status
    // once the case ended. The facts rail keeps the objection deadline ("Reopen before").
    const header = readFileSync(path.resolve(__dirname, '..', 'casedetail', 'CaseHeaderMeta.tsx'), 'utf8');
    expect(header).toContain('<OutcomeBadge outcome={outcome}');
    const rail = readFileSync(path.resolve(__dirname, '..', 'casedetail', 'FactsRail.tsx'), 'utf8');
    expect(rail).toContain("isAutoClosedByAI(c.status, c.decision_by) ? 'Reopen before '");
    expect(src).toContain('<CaseHeaderMeta');
  });

  it('the tab triggers carry their counts (runbook progress, trace steps, messages)', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    expect(tabsList).toContain('<TabCount label="steps">');
    expect(tabsList).toContain('<TabCount label="messages">');
    expect(tabsList).not.toContain('<TabCount label="MITRE techniques">');
  });

  it('keeps "Open in new tab" in More options + the widened sheet (task 7a/7b)', () => {
    const more = slice(src, 'aria-label="More options"', '</DropdownMenu>');
    expect(more).toContain('Copy link');
    expect(more).toContain('openInNewTab()');
    expect(more).toContain('Open in new tab');
    // The default sheet still targets Cases; embedded mode preserves Case Manager.
    expect(src).toContain("presentation === 'embedded' ? 'case_manager' : 'cases'");
    expect(src).toContain('#/${routeId}?caseId=${encodeURIComponent(id)}');
    expect(src).toContain('max-w-[min(98vw,1400px)]');
  });

  it('supports an embedded presentation without forking the five-tab workflow', () => {
    expect(src).toContain("type CaseDetailPresentation = 'sheet' | 'embedded'");
    expect(src).toContain("presentation = 'sheet'");
    expect(src).toContain("if (presentation === 'embedded')");
    expect(src).toMatch(/<CaseDetailSurface\s+presentation=\{presentation\}\s+open=\{open\}\s+onClose=\{onClose\}/);
    expect(src).toContain('onCaseChange?.(next)');
    expect(src).toContain('commitCase(next)');
  });
});

describe('CaseDetail: the Runbook tab (Round 14, SPEC §4.10.11)', () => {
  it('shows the Runbook tab only to a viewer who can read runbooks, with its progress count', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    const trigger = slice(tabsList, '{showRunbookTab ? (', ') : null}');
    expect(trigger).toContain('value="runbook"');
    // "Abandoned", never "None", when the only runs on the case were abandoned.
    expect(trigger).toContain('<RunbookTabCount progress={runbookProgress} abandoned={runbookData.runs.length > 0} />');
    expect(src).toContain("const canReadRunbooks = hasPermission('runbooks', 'read') && hasPermission('cases', 'read');");
    expect(src).toContain('const showRunbookTab = canReadRunbooks;');
    // Alt+2 does nothing for a viewer with no Runbook tab.
    expect(src).toContain("if (next === 'runbook' && !state.hasRunbookTab) return;");
  });

  it('loads the Runbook panel lazily and only from the Runbook tab', () => {
    expect(src).toMatch(/const RunbookPanel = React\.lazy\(\(\) => import\('\.\/casedetail\/RunbookPanel'\)\)/);
    const content = slice(src, '<TabsContent value="runbook"', '</TabsContent>');
    expect(content).toContain('<React.Suspense');
    // Runbooks turned off make the run read only too (the server refuses every run write).
    expect(content).toContain('canRun={canRunRunbooks && shownIsCurrent}');
    expect(content).toContain('enabled={runbookPrefs.enabled}');
    expect(content).toContain('viewer={runbookViewer}');
    expect(content).toContain('focusRequest={runbookRequest}');
    // A handled request is forgotten, so coming back to the tab never replays it.
    expect(content).toContain('onFocusRequestHandled={runbookRequestHandled}');
    expect(src).toContain('setRunbookRequest((current) => (current?.tick === tick ? null : current));');
    expect(src).toContain('runbookTickRef.current += 1;');
  });

  it('removes "Run a playbook" and offers "Start runbook" in Take action instead', () => {
    expect(src).not.toMatch(/Run a playbook|runPlaybook|playbooks\.length/);
    const menu = slice(src, '{canReadRunbooks && canRunRunbooks && runbookPrefs.enabled ? (', ') : null}');
    expect(menu).toContain("requestRunbook({ kind: 'start' })");
    expect(menu).toContain('Start runbook');
  });

  it('repeats the Next step card on the Overview of an open case and points Collaboration at Other tasks', () => {
    const overview = slice(src, '<TabsContent value="overview"', '</TabsContent>');
    expect(overview).toContain('runbookCard={');
    expect(overview).toContain('!caseIsTerminal(c.status)');
    expect(overview).toContain('<OverviewNextStep');
    const collab = slice(src, '<TabsContent value="collab"', '</TabsContent>');
    expect(collab).toContain("onOpenTasks={showRunbookTab ? () => requestRunbook({ kind: 'tasks' }) : undefined}");
    expect(collab).toContain('<OtherTasksLoader');
  });

  it('asks the close dialog for a reason when required steps are open (D34)', () => {
    expect(src).toContain('input.require_open_steps_reason = true;');
    expect(src).toContain('if (reason) input.open_steps_reason = reason;');
    expect(src).toContain("const refused = stepsOpenRefusal(e);");
    const dialog = slice(src, '<ConfirmActionDialog', '/>');
    for (const prop of [
      'openSteps={dialogOpenSteps}',
      'openStepsReason={openStepsReason}',
      'openStepsError={openStepsError}',
    ]) {
      expect(dialog).toContain(prop);
    }
  });
});
