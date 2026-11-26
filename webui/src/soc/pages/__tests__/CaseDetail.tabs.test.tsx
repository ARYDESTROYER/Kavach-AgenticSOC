/**
 * CaseDetail: the six-tab shell, one lane each (Round 16, SPEC D8, §4.4 WP03; Round 15
 * D8.3 had five, Round 14 added the Runbook tab).
 *
 *     overview · evidence · investigation · runbook · collab · chat
 *     Brief      Evidence   AI investigation Response Activity Chat
 *
 *   - "Brief" holds the Next step row, the four lanes and, folded, the six-stage story
 *     (<TimelinePanel>, its stages load when it opens).
 *   - "Evidence" holds What happened (the ingestion stage of the story and the events),
 *     entities, threat context (<ThreatContextPanel>, loaded when Evidence opens), related
 *     cases and the baseline (<EvidencePanel>).
 *   - "AI investigation" holds the assessment, the inputs, the trace and the gradings
 *     (<InvestigationPanel>); the decision moved to the Brief.
 *   - "Response" holds the runbook (lazy, `runbooks:read`) and the tasks, for everyone.
 *
 * A link to a retired tab id (`timeline`, `threat`), or to a section that moved, is
 * rewritten by the router (router-case-tabs.round15.test.tsx, and the mounted
 * CaseDetail.requested-tab.test.tsx). This spec pins, as STATIC assertions on the
 * orchestrator source (the load-bearing tab wiring), not a full mount.
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

const TAB_VALUES = ['overview', 'evidence', 'investigation', 'runbook', 'collab', 'chat'] as const;
const REMOVED_TABS = ['why', 'trace', 'feedback', 'timeline', 'threat'] as const;

/** value → expected human label + the panel component(s) mounted for it. */
const TAB_LABEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'Brief',
  evidence: 'Evidence',
  investigation: 'AI investigation',
  runbook: 'Response',
  collab: 'Activity',
  chat: 'Chat',
};
const TAB_PANELS: Record<(typeof TAB_VALUES)[number], readonly string[]> = {
  overview: ['OverviewPanel', 'TimelinePanel'],
  evidence: ['EvidencePanel', 'TimelinePanel', 'ThreatContextPanel'],
  investigation: ['InvestigationPanel'],
  runbook: ['RunbookPanel', 'OtherTasksLoader'],
  collab: ['CollaborationThreadTab'],
  chat: ['ChatTab'],
};

describe('CaseDetail: the six-tab shell (Round 16, D8)', () => {
  it('the tab union is exactly the six tabs (the removed panels are gone)', () => {
    // The Brief by default; a link's tab (Case Manager's `tab` key) opens first, validated
    // against the union below. Every tab is shown to every viewer.
    expect(src).toContain("React.useState<CaseTab>(() => requestedTab ?? 'overview')");
    expect(src).toContain('const requestedTab = isCaseTab(requestedTabId) ? requestedTabId : null;');
    // The page reads the ONE tab list the router's `tab` key also validates against; it
    // defines none itself.
    expect(src).toContain("import { CASE_SECTION_TABS, CASE_TABS, isCaseTab, type CaseTab } from '@/soc/case-tabs';");
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

  it('renders exactly six compact underline TabsTrigger, each value matching its label, on Alt+1 to Alt+6', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    // Record sections are underline tabs, 36px in the case header (`density="compact"`).
    expect(tabsList).toContain('<TabsList variant="underline" density="compact"');
    const triggers = tabsList.match(/<TabsTrigger\s+value="[^"]+"/g) || [];
    expect(triggers.length).toBe(6);
    expect(triggers.map((t) => /value="([^"]+)"/.exec(t)?.[1])).toEqual([...TAB_VALUES]);
    const keys = tabsList.match(/aria-keyshortcuts="Alt\+(\d)"/g) || [];
    expect(keys).toEqual(TAB_VALUES.map((_, i) => `aria-keyshortcuts="Alt+${i + 1}"`));
    // The key handler accepts Digit1 to Digit6 and indexes CASE_TABS, with no grant gate.
    expect(src).toContain('/^Digit([1-6])$/');
    expect(src).toContain('setTab(CASE_TABS[Number(digit[1]) - 1]);');
    expect(src).not.toContain('hasRunbookTab');

    for (const v of TAB_VALUES) {
      const trigger = slice(tabsList, `value="${v}"`, 'TabsTrigger>');
      expect(trigger, `trigger '${v}' should be labeled "${TAB_LABEL[v]}"`).toContain(TAB_LABEL[v]);
    }
    for (const v of REMOVED_TABS) {
      expect(tabsList).not.toContain(`value="${v}"`);
    }
    // No Console copy names the old tab labels.
    expect(tabsList).not.toMatch(/>\s*(Overview|Runbook|Investigation|Collaboration)\s*</);
  });

  it('each TabsContent mounts its panels', () => {
    for (const v of TAB_VALUES) {
      const content = slice(src, `<TabsContent value="${v}"`, '</TabsContent>');
      for (const panel of TAB_PANELS[v]) {
        expect(content, `TabsContent '${v}' should mount <${panel}>`).toContain(`<${panel}`);
      }
    }
    // One mount site per panel, except the story (the Brief's fold and Evidence's input stage).
    for (const comp of ['OverviewPanel', 'EvidencePanel', 'InvestigationPanel', 'ThreatContextPanel', 'CollaborationThreadTab', 'ChatTab']) {
      expect((src.match(new RegExp(`<${comp}\\b`, 'g')) || []).length).toBe(1);
    }
    expect((src.match(/<TimelinePanel\b/g) || []).length).toBe(2);
    for (const v of REMOVED_TABS) {
      expect(src).not.toContain(`<TabsContent value="${v}"`);
    }
  });

  it('the merged sub-panels + retired Feedback tab are not mounted in the shell', () => {
    for (const gone of ['StageTimeline', 'WhyPanel', 'FeedbackTab', 'ReviewBand', 'OverviewNextStep']) {
      expect(src, `${gone} must not be referenced by the shell`).not.toContain(gone);
    }
    // The trace mounts in the AI investigation tab only; the shell reads its step counter
    // for the tab count (XFCM) and nothing else from it.
    expect(src).not.toMatch(/<TraceTimeline\b/);
    expect(src).toContain("import { traceStepCounts } from '@/soc/components/TraceTimeline';");
  });

  it('the Brief carries the folded story, the Next step row and the Decision lane inputs', () => {
    const content = slice(src, '<TabsContent value="overview"', '</TabsContent>');
    const story = slice(content, 'buildStory={', '/>');
    expect(story).toContain('<TimelinePanel');
    for (const prop of ['stages={stages}', 'onRetryStages={loadStages}', "onOpenInvestigation={() => setTab('investigation')}"]) {
      expect(story, `the story should receive ${prop}`).toContain(prop);
    }
    for (const prop of [
      'rationale={rationale}',
      'buildStoryOpen={storyOpen}',
      'onBuildStoryOpenChange={setStoryOpen}',
      'policy={verdictPolicy}',
      'timeline={timeline}',
      'reviewPending={layout.startReview}',
      'onOpenTab={setTab}',
    ]) {
      expect(content, `the Brief should receive ${prop}`).toContain(prop);
    }
    // The Next step row needs a run the viewer may read (an open case, checked in the Brief).
    expect(content).toContain('runbookRun={canReadRunbooks ? shownRun : null}');
  });

  it('Evidence carries the ingestion stage, the threat context and the finding filter', () => {
    const content = slice(src, '<TabsContent value="evidence"', '</TabsContent>');
    const story = slice(content, 'sourceStory={', 'threatContext={');
    expect(story).toContain('<TimelinePanel');
    expect(story).toContain('kinds={SOURCE_STAGES}');
    expect(src).toContain("const SOURCE_STAGES: readonly string[] = ['input'];");
    const threat = slice(content, 'threatContext={', '</TabPanelMotion>');
    expect(threat).toContain('<ThreatContextPanel');
    expect(threat).toContain('panel={threat}');
    expect(threat).toContain('onRetry={loadThreat}');
    expect(content).toContain('filterEventIds={eventFilter}');
    expect(content).toContain('onClearEventFilter={() => setEventFilter(null)}');
  });

  it('AI investigation carries the rationale and timeline state, and no decision or threat context', () => {
    const content = slice(src, '<TabsContent value="investigation"', '</TabsContent>');
    for (const prop of [
      'rationale={rationale}',
      'onRetryRationale={loadRationale}',
      'timeline={timeline}',
      'onRetryTimeline={loadTimeline}',
      'aiRunning={aiRunning}',
      'onShowEvents={showFindingEvents}',
    ]) {
      expect(content, `investigation panel should receive ${prop}`).toContain(prop);
    }
    expect(content).not.toContain('stages={stages}');
    expect(content).not.toContain('threatContext');
    expect(content).not.toContain('fpPolicy');
    expect(content).not.toContain('policy=');
  });

  it('renders every panel in its one Case Manager layout, with no presentation to choose', () => {
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

  it('stages and threat context load with Evidence, the trace with AI investigation, rationale with the Brief', () => {
    expect(src).toContain("const wantsStages = tab === 'evidence' || (tab === 'overview' && storyOpen);");
    expect(src).toContain('wantsStages && stages === null && !stagesLoading && !stagesError');
    expect(src).toContain("tab === 'evidence' && threat === null && !threatLoading && !threatError");
    expect(src).toContain(
      "const needsRationale = tab === 'investigation' || tab === 'overview' || presentation === 'embedded'",
    );
    expect(src).toContain('needsRationale && rationale === null && !rationaleLoading && !rationaleError');
    expect(src).toContain("const wantsTimeline = tab === 'investigation' || (tab === 'overview' && timelineWanted);");
    expect(src).toContain('wantsTimeline && timeline === null && !timelineLoading && !timelineError');
    for (const v of REMOVED_TABS) {
      expect(src).not.toContain(`tab === '${v}'`);
    }
  });

  it('the header keeps the ONE outcome badge and the inspector its auto-close deadline', () => {
    const header = readFileSync(path.resolve(__dirname, '..', 'casedetail', 'CaseHeaderMeta.tsx'), 'utf8');
    expect(header).toContain('<OutcomeBadge outcome={outcome}');
    const rail = readFileSync(path.resolve(__dirname, '..', 'casedetail', 'FactsRail.tsx'), 'utf8');
    expect(rail).toContain("isAutoClosedByAI(c.status, c.decision_by) ? 'Reopen before '");
    expect(src).toContain('<CaseHeaderMeta');
  });

  it('the tab triggers carry their counts (runbook progress, AI steps, messages)', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    // The AI's own steps, the trace's "N AI steps" (XFCM), never every span.
    expect(tabsList).toContain("<TabCount label={traceAiSteps === 1 ? 'AI step' : 'AI steps'}>");
    expect(tabsList).not.toContain('<TabCount label="steps">');
    // One message reads "1 message" to a screen reader, never "1 messages" (FXA1 review).
    expect(tabsList).toContain("<TabCount label={messageCount === 1 ? 'message' : 'messages'}>");
    expect(tabsList).not.toContain('<TabCount label="messages">');
    expect(tabsList).toContain('<RunbookTabCount progress={runbookProgress} abandoned={runbookData.runs.length > 0} />');
    expect(tabsList).not.toContain('<TabCount label="MITRE techniques">');
  });

  it('keeps "Open in new tab" in More options + the widened sheet (task 7a/7b)', () => {
    const more = slice(src, 'aria-label="More options"', '</DropdownMenu>');
    expect(more).toContain('Copy link');
    expect(more).toContain('openInNewTab()');
    expect(more).toContain('Open in new tab');
    expect(src).toContain("presentation === 'embedded' ? 'case_manager' : 'cases'");
    expect(src).toContain('#/${routeId}?caseId=${encodeURIComponent(id)}');
    expect(src).toContain('max-w-[min(98vw,1400px)]');
  });

  it('supports an embedded presentation without forking the six-tab workflow', () => {
    expect(src).toContain("type CaseDetailPresentation = 'sheet' | 'embedded'");
    expect(src).toContain("presentation = 'sheet'");
    expect(src).toContain("if (presentation === 'embedded')");
    expect(src).toMatch(/<CaseDetailSurface\s+presentation=\{presentation\}\s+open=\{open\}\s+onClose=\{onClose\}/);
    expect(src).toContain('onCaseChange?.(next)');
    expect(src).toContain('commitCase(next)');
  });
});

describe('CaseDetail: the Response tab (Round 16, D8; Round 14 SPEC §4.10.11)', () => {
  it('shows the Response tab to every viewer: the runbook with runbooks:read, the tasks always', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    // The trigger is unconditional, so Alt+4 always means Response.
    expect(tabsList).not.toContain('showRunbookTab');
    expect(src).toContain("const canReadRunbooks = hasPermission('runbooks', 'read') && hasPermission('cases', 'read');");
    const content = slice(src, '<TabsContent value="runbook"', '</TabsContent>');
    const tasks = slice(content, ') : (', '</TabPanelMotion>');
    expect(tasks).toContain('<PanelSection title="Tasks"');
    expect(tasks).toContain('<OtherTasksLoader caseId={c.case_id} canWrite={canWriteCase} nameOf={nameOf} />');
  });

  it('loads the Runbook panel lazily and only from the Response tab', () => {
    expect(src).toMatch(/const RunbookPanel = React\.lazy\(\(\) => import\('\.\/casedetail\/RunbookPanel'\)\)/);
    const content = slice(src, '<TabsContent value="runbook"', '</TabsContent>');
    expect(content).toContain('<React.Suspense');
    expect(content).toContain('canRun={canRunRunbooks && shownIsCurrent}');
    expect(content).toContain('enabled={runbookPrefs.enabled}');
    expect(content).toContain('viewer={runbookViewer}');
    expect(content).toContain('focusRequest={runbookRequest}');
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

  it('Activity no longer points at the tasks: they are on Response', () => {
    const collab = slice(src, '<TabsContent value="collab"', '</TabsContent>');
    expect(collab).not.toContain('onOpenTasks');
    expect(collab).not.toContain('tasksSection');
    expect(collab).not.toContain('<OtherTasksLoader');
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
      'caseIds={c && shownIsCurrent ? [c.case_id] : undefined}',
    ]) {
      expect(dialog).toContain(prop);
    }
  });

  it('mounts the Reinvestigate dialog stub in place of the inline dialog', () => {
    expect(src).toContain('<ReinvestigateDialog');
    expect(src).not.toContain('Re-run the investigation');
    expect(src).not.toContain('runReinvestigate');
  });
});
