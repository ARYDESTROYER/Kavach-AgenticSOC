/**
 * CaseDetail — 6-tab story shell (task 5: split the merged Timeline tab).
 *
 * Task 5 split the old merged "Timeline" tab (which held BOTH the "what happened"
 * narrative AND the full ReAct trace) into two clean tabs:
 *
 *     overview · timeline · investigation · threat · collab · chat
 *
 *   - "Timeline"      = ONLY the "what happened" six-stage narrative (<TimelinePanel>).
 *   - "Investigation" = the AI assessment (WhyPanel) + the pinned deterministic
 *                       DecisionCard + the collapsible full ReAct trace
 *                       (<InvestigationPanel>).
 *
 * The standalone Feedback tab stays retired (grading folds into the close dialog; the
 * aggregate stays in Metrics). This spec pins:
 *
 *   1. The `tab` union is EXACTLY the 6 story tabs — the removed values are gone.
 *   2. Exactly 6 <TabsTrigger>, each `value` matching its human label.
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

const TAB_VALUES = ['overview', 'timeline', 'investigation', 'threat', 'collab', 'chat'] as const;
// 'investigation' is now a REAL tab (task 5); only the truly-removed panels stay gone.
const REMOVED_TABS = ['why', 'trace', 'feedback'] as const;

/** value → expected human label + the panel component mounted for it. */
const TAB_LABEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'Overview',
  timeline: 'Timeline',
  investigation: 'Investigation',
  threat: 'Threat context',
  collab: 'Collaboration',
  chat: 'Chat',
};
const TAB_PANEL: Record<(typeof TAB_VALUES)[number], string> = {
  overview: 'OverviewPanel',
  timeline: 'TimelinePanel',
  investigation: 'InvestigationPanel',
  threat: 'ThreatContextPanel',
  collab: 'CollaborationThreadTab',
  chat: 'ChatTab',
};

describe('CaseDetail — 6-tab story shell (task 5)', () => {
  it('the tab union is exactly the 6 story tabs (the removed panels are gone)', () => {
    const union = slice(src, 'const [tab, setTab] = React.useState<', ">('overview')");
    for (const v of TAB_VALUES) expect(union, `union should include '${v}'`).toContain(`'${v}'`);
    for (const v of REMOVED_TABS) {
      expect(union, `union should NOT include the removed '${v}'`).not.toContain(`'${v}'`);
    }
  });

  it('renders exactly 6 TabsTrigger, each value matching its human label', () => {
    const tabsList = slice(src, '<TabsList', '</TabsList>');
    const triggers = tabsList.match(/<TabsTrigger\s+value="[^"]+"/g) || [];
    expect(triggers.length).toBe(6);

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

  it('forwards the embedded Case Manager presentation to all six shared panels', () => {
    // Round 12: the Cases sheet converged on the same design, so every surface (sheet and
    // embedded) forwards the ONE Case Manager panel presentation.
    const presentationProp = 'presentation="case-manager"';
    for (const value of TAB_VALUES) {
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

  it('supports an embedded presentation without forking the six-tab workflow', () => {
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
