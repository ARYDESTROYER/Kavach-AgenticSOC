/**
 * CaseDetail: the 7-tab story shell (task 5 split the merged Timeline tab; Round 14 added
 * the Runbook tab second, SPEC §4.10.11).
 *
 * Task 5 split the old merged "Timeline" tab (which held BOTH the "what happened"
 * narrative AND the full ReAct trace) into two clean tabs:
 *
 *     overview · runbook · timeline · investigation · threat · collab · chat
 *
 *   - "Timeline"      = ONLY the "what happened" six-stage narrative (<TimelinePanel>).
 *   - "Investigation" = the AI assessment (WhyPanel) + the pinned deterministic
 *                       DecisionCard + the collapsible full ReAct trace
 *                       (<InvestigationPanel>).
 *
 * The standalone Feedback tab stays retired (grading folds into the close dialog; the
 * aggregate stays in Metrics). This spec pins:
 *
 *   1. The `tab` union is EXACTLY the 7 story tabs; the removed values are gone.
 *   2. Exactly 7 <TabsTrigger>, each `value` matching its human label, in order, with
 *      Alt+1 to Alt+7 in that order.
 *   3. Each <TabsContent> renders the RIGHT, DISTINCT panel; the merged sub-panels
 *      (StageTimeline / WhyPanel / TraceTimeline) and the retired FeedbackTab are NOT
 *      mounted directly in the shell.
 *   4. <TimelinePanel> is wired the stages state + retry (lazy on `timeline`);
 *      <InvestigationPanel> is wired the rationale / timeline state + retries (lazy on
 *      `investigation` so the DecisionCard can read its policy clause).
 *   5. The header carries a self-hiding <AutoClosedBadge> (Round-7 #11).
 *
 * CaseDetail is a large sheet with heavy prop/api coupling, so — like the sibling
 * CaseDetail.*.test.tsx specs — these are STATIC assertions on the orchestrator source
 * (the load-bearing tab wiring), not a full mount. #9 is unaffected.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(__dirname, '..', 'CaseDetail.tsx'), 'utf8');

/** Slice from the first occurrence of `needle` to the next `end` (exclusive). */
function slice(text: string, needle: string, end: string): string {
  const i = text.indexOf(needle);
  expect(i, `expected to find "${needle}"`).toBeGreaterThan(-1);
  const j = text.indexOf(end, i + needle.length);
  return text.slice(i, j === -1 ? text.length : j);
}

const TAB_VALUES = ['overview', 'runbook', 'timeline', 'investigation', 'threat', 'collab', 'chat'] as const;
// 'investigation' is now a REAL tab (task 5); only the truly-removed panels stay gone.
const REMOVED_TABS = ['why', 'trace', 'feedback'] as const;

/** value → expected human label + the panel component mounted for it. */
const TAB_LABEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'Overview',
  runbook: 'Runbook',
  timeline: 'Timeline',
  investigation: 'Investigation',
  threat: 'Threat context',
  collab: 'Collaboration',
  chat: 'Chat',
};
const TAB_PANEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'OverviewPanel',
  runbook: 'RunbookPanel',
  timeline: 'TimelinePanel',
  investigation: 'InvestigationPanel',
  threat: 'ThreatContextPanel',
  collab: 'CollaborationThreadTab',
  chat: 'ChatTab',
};

describe('CaseDetail: the 7-tab story shell (task 5, Round 14)', () => {
  it('the tab union is exactly the 7 story tabs (the removed panels are gone)', () => {
    expect(src).toContain('const [tab, setTab] = React.useState<CaseTab>(\'overview\')');
    const union = slice(src, 'const CASE_TABS = [', '] as const;');
    expect(union).toBe(`const CASE_TABS = [${TAB_VALUES.map((v) => `'${v}'`).join(', ')}`);
    for (const v of REMOVED_TABS) {
      expect(union, `union should NOT include the removed '${v}'`).not.toContain(`'${v}'`);
    }
  });

  it('renders exactly 7 TabsTrigger, each value matching its human label', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    const triggers = tabsList.match(/<TabsTrigger\s+value="[^"]+"/g) || [];
    expect(triggers.length).toBe(7);
    expect(triggers.map((t) => /value="([^"]+)"/.exec(t)?.[1])).toEqual([...TAB_VALUES]);
    // Alt+1 to Alt+7 follow the tab order (the keyboard handler indexes CASE_TABS).
    const keys = tabsList.match(/aria-keyshortcuts="Alt\+(\d)"/g) || [];
    expect(keys).toEqual(TAB_VALUES.map((_, i) => `aria-keyshortcuts="Alt+${i + 1}"`));

    for (const v of TAB_VALUES) {
      const trigger = slice(tabsList, `value="${v}"`, 'TabsTrigger>');
      expect(trigger, `trigger '${v}' should be labeled "${TAB_LABEL[v]}"`).toContain(
        TAB_LABEL[v],
      );
    }
    for (const v of REMOVED_TABS) {
      expect(tabsList).not.toContain(`value="${v}"`);
    }
  });

  it('each TabsContent mounts the correct, DISTINCT panel', () => {
    for (const v of TAB_VALUES) {
      const content = slice(src, `<TabsContent value="${v}"`, '</TabsContent>');
      expect(content, `TabsContent '${v}' should mount <${TAB_PANEL[v]}>`).toContain(
        `<${TAB_PANEL[v]}`,
      );
    }
    // Exactly one mount site per panel.
    for (const comp of Object.values(TAB_PANEL)) {
      expect((src.match(new RegExp(`<${comp}\\b`, 'g')) || []).length).toBe(1);
    }
  });

  it('the merged sub-panels + retired Feedback tab are not mounted in the shell', () => {
    // StageTimeline / WhyPanel / TraceTimeline live INSIDE the Timeline / Investigation
    // panels, not as standalone tabs; FeedbackTab was retired entirely.
    for (const gone of ['StageTimeline', 'WhyPanel', 'TraceTimeline', 'FeedbackTab']) {
      expect(src, `${gone} must not be referenced by the shell`).not.toContain(gone);
    }
  });

  it('TimelinePanel is wired the stages state + retry (in the Timeline tab)', () => {
    const content = slice(src, '<TabsContent value="timeline"', '</TabsContent>');
    for (const prop of ['stages={stages}', 'onRetryStages={loadStages}']) {
      expect(content, `timeline panel should receive ${prop}`).toContain(prop);
    }
  });

  it('InvestigationPanel is wired the rationale/timeline state + retries (in the Investigation tab)', () => {
    const content = slice(src, '<TabsContent value="investigation"', '</TabsContent>');
    for (const prop of [
      'rationale={rationale}',
      'onRetryRationale={loadRationale}',
      'timeline={timeline}',
      'onRetryTimeline={loadTimeline}',
    ]) {
      expect(content, `investigation panel should receive ${prop}`).toContain(prop);
    }
    // The stages are the Timeline tab's business now — NOT wired to InvestigationPanel.
    expect(content).not.toContain('stages={stages}');
  });

  it('forwards the embedded Case Manager presentation to the six shared panels', () => {
    // Round 12: the Cases sheet converged on the same design, so every surface (sheet and
    // embedded) forwards the ONE Case Manager panel presentation. The Runbook panel has a
    // single presentation and takes the same panel padding instead.
    const presentationProp = 'presentation="case-manager"';
    const runbook = slice(src, '<TabsContent value="runbook"', '</TabsContent>');
    expect(runbook).toContain('className={CASE_MANAGER_PANEL_PADDING}');
    for (const value of TAB_VALUES.filter((v) => v !== 'runbook')) {
      const content = slice(src, `<TabsContent value="${value}"`, '</TabsContent>');
      expect(
        content,
        `TabsContent '${value}' must forward the shared presentation contract`,
      ).toContain(presentationProp);
    }
  });

  it('gives only the embedded Chat tab the full-height, internally-scrolling lane', () => {
    const scrollLane = slice(src, 'ref={panelScrollRef}', '<TabsContent value="overview"');
    expect(scrollLane).toContain("tab === 'chat' ? 'overflow-hidden' : 'overflow-y-auto'");

    const chat = slice(src, '<TabsContent value="chat"', '</TabsContent>');
    expect(chat).toContain('h-full min-h-0');

    // No other tab receives this height/overflow override.
    for (const value of TAB_VALUES.filter((value) => value !== 'chat')) {
      const content = slice(src, `<TabsContent value="${value}"`, '</TabsContent>');
      expect(content).not.toContain('h-full min-h-0');
    }
  });

  it('wires the Case Manager Timeline trace CTA to the existing Investigation tab', () => {
    const content = slice(src, '<TabsContent value="timeline"', '</TabsContent>');
    expect(content).toContain("onOpenInvestigation={() => setTab('investigation')}");
  });

  it('stages lazy-load on the timeline tab; rationale for embedded Case Manager and the investigation tab', () => {
    expect(src).toContain(
      "tab === 'timeline' && stages === null && !stagesLoading && !stagesError",
    );
    expect(src).toContain(
      "const needsRationale = tab === 'investigation' || presentation === 'embedded'",
    );
    expect(src).toContain(
      'needsRationale && rationale === null && !rationaleLoading && !rationaleError',
    );
    expect(src).toContain(
      "tab === 'investigation' && timeline === null && !timelineLoading && !timelineError",
    );
    // No lingering effect keyed on a removed tab value.
    for (const v of REMOVED_TABS) {
      expect(src).not.toContain(`tab === '${v}'`);
    }
  });

  it('the header carries a self-hiding AutoClosedBadge (Round-7 #11)', () => {
    // Round 12 (D15): the header meta row carries the ONE outcome badge, which says
    // "Auto-closed" for an AI auto-close and nothing while the case is pending; the
    // facts rail keeps the auto-close objection deadline ("Reopen before …").
    const header = readFileSync(
      path.resolve(__dirname, '..', 'casedetail', 'CaseHeaderMeta.tsx'),
      'utf8',
    );
    expect(header).toContain('<OutcomeBadge outcome={outcome} />');
    const rail = readFileSync(path.resolve(__dirname, '..', 'casedetail', 'FactsRail.tsx'), 'utf8');
    expect(rail).toContain("isAutoClosedByAI(c.status, c.decision_by) ? 'Reopen before '");
    expect(src).toContain('<CaseHeaderMeta');
  });

  it('the header quick-jumps target the Timeline + Investigation tabs', () => {
    // Round 12: the tab triggers themselves carry the counts the quick-jumps used to
    // advertise (steps, MITRE techniques, messages + open tasks); Timeline's trace CTA
    // still jumps to Investigation.
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    expect(tabsList).toContain('<TabCount label="steps">');
    expect(tabsList).toContain('<TabCount label="MITRE techniques">');
    expect(tabsList).toContain('<TabCount label="messages">');
    const timeline = slice(src, '<TabsContent value="timeline"', '</TabsContent>');
    expect(timeline).toContain("onOpenInvestigation={() => setTab('investigation')}");
  });

  it('adds an accessible "Open in new tab" header control + widens the sheet (task 7a/7b)', () => {
    // Round 12: "Open in new tab" lives in the header's Share menu, wired to openInNewTab.
    const openItem = slice(src, 'openInNewTab();', 'Open in new tab');
    expect(openItem).toBeTruthy();
    // The default sheet still targets Cases; embedded mode preserves Case Manager.
    expect(src).toContain("presentation === 'embedded' ? 'case_manager' : 'cases'");
    expect(src).toContain('#/${routeId}?caseId=${encodeURIComponent(id)}');
    // The sheet is widened from 1180px to 1400px (task 7a).
    expect(src).toContain('max-w-[min(98vw,1400px)]');
  });

  it('supports an embedded presentation without forking the seven-tab workflow', () => {
    expect(src).toContain("type CaseDetailPresentation = 'sheet' | 'embedded'");
    expect(src).toContain("presentation = 'sheet'");
    expect(src).toContain("if (presentation === 'embedded')");
    expect(src).toMatch(
      /<CaseDetailSurface\s+presentation=\{presentation\}\s+open=\{open\}\s+onClose=\{onClose\}/,
    );
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
