/**
 * Source-level guard for the Console page-anatomy contract.
 *
 * Runtime tests cover the individual workflows; this guard prevents a routed surface
 * from quietly re-introducing a private width/header/motion grammar. Host-tab pages own
 * the shared PageContainer/PageHeader while their child panels remain embeddable.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");

// Round 14 (W8a): Analytics.tsx only routes to the Metrics, Agent effectiveness and Cost
// pages, and each of those owns its container and header, so the three pages are listed.
const PRIMARY_SURFACES = [
  "soc/pages/AgentEffectiveness.tsx",
  "soc/pages/Approvals.tsx",
  "soc/pages/Audit.tsx",
  "soc/pages/Baseline.tsx",
  "soc/pages/BatchJobs.tsx",
  "soc/pages/Campaigns.tsx",
  "soc/pages/Cases.tsx",
  "soc/pages/Cost.tsx",
  "soc/pages/Dashboards.tsx",
  "soc/pages/Docs.tsx",
  "soc/pages/Inbox.tsx",
  "soc/pages/Intelligence.tsx",
  "soc/pages/Knowledge.tsx",
  "soc/pages/Metrics.tsx",
  "soc/pages/Models.tsx",
  "soc/pages/Overview.tsx",
  "soc/pages/Settings.tsx",
  "soc/pages/Sources.tsx",
  "soc/pages/Standup.tsx",
  "soc/pages/Tuning.tsx",
  "soc/pages/Workspace.tsx",
  "soc/components/UnifiedLogsSheet.tsx",
] as const;

const source = (relative: string) =>
  readFileSync(path.join(SRC, relative), "utf8");

describe("Console route visual standard", () => {
  it.each(PRIMARY_SURFACES)(
    "%s composes the shared page container and header",
    (file) => {
      const text = source(file);
      expect(
        text,
        `${file} must use the one routed-page width authority`,
      ).toContain("<PageContainer");
      expect(
        text,
        `${file} must use the one routed-page heading/action authority`,
      ).toContain("<PageHeader");
    },
  );

  it.each(PRIMARY_SURFACES)(
    "%s does not attach a second route-entry fade to PageContainer",
    (file) => {
      expect(source(file)).not.toMatch(
        /<PageContainer\b[^>]*className="[^"]*animate-fade-in/,
      );
    },
  );

  it("keeps the custom split workspace and tab host exceptions explicit", () => {
    const manager = source("soc/pages/CaseManager.tsx");
    expect(manager).toContain("<PageContainer");
    expect(manager).toContain('variant="fluid"');
    expect(manager).toContain("w-auto sm:-mx-2");
    expect(manager).toContain('role="separator"');
    // The bleed no longer steps with the old gutter ladder, so it must not re-grow one.
    expect(manager).not.toContain("lg:-mx-4");
    expect(manager).not.toContain("2xl:-mx-8");
  });

  it("keeps the shell gutter and the Case Manager bleed a MATCHED PAIR", () => {
    // These two strings are the whole contract: the bleed widens the board back out of the
    // shell gutter to a constant 16px inset at every width. Tuned independently they drift,
    // and at >=1536px the board overflows `<main class="… overflow-x-hidden">` by 8px/side.
    // jsdom cannot see either (no layout, no media queries), so the source strings ARE the
    // proof — no other gate covers this.
    expect(source("soc/AppShell.tsx")).toContain(
      "const CONTENT_INSET = 'mx-auto w-full min-w-0 px-4 py-6 sm:px-6';",
    );
    expect(source("soc/pages/CaseManager.tsx")).toContain(
      'className="h-[calc(100dvh-7rem)] min-h-0 w-auto sm:-mx-2 xl:min-h-[600px]"',
    );

    const home = source("soc/pages/Home.tsx");
    expect(home).toContain("<Overview");
    expect(home).toContain("<Standup");
    expect(home).not.toContain("<PageHeader");
  });

  it("keeps every embedded Case Manager tab on one shared content rail", () => {
    const shared = source("soc/pages/casedetail/shared.tsx");
    expect(shared).toContain("export const CASE_MANAGER_PANEL_PADDING");
    expect(shared).toContain("px-4 py-4 sm:px-5 sm:py-5 lg:px-6");

    for (const file of [
      "soc/pages/casedetail/OverviewPanel.tsx",
      "soc/pages/casedetail/TimelinePanel.tsx",
      "soc/pages/casedetail/InvestigationPanel.tsx",
      "soc/pages/casedetail/ThreatContextPanel.tsx",
      "soc/pages/casedetail/CollaborationPanel.tsx",
      "soc/pages/casedetail/CaseChatPanel.tsx",
    ]) {
      expect(source(file), `${file} must reuse the Case Manager content rail`).toContain(
        "CASE_MANAGER_PANEL_PADDING",
      );
    }
  });

  it("lets Workspace Chat own its full-height frame instead of a page container (chat revamp §10.1a)", () => {
    const workspace = source("soc/pages/Workspace.tsx");
    const chat = source("soc/pages/Chat.tsx");
    const frame = source("soc/chat/workspace/ChatWorkspace.tsx");
    const history = source("soc/chat/workspace/HistoryRail.tsx");

    // Both Workspace tabs are lazy so Chat never downloads the case-detail chunk.
    expect(workspace).toContain("const Chat = React.lazy(() => import('./Chat'));");
    expect(workspace).toContain("const Investigate = React.lazy(() => import('./Investigate'));");
    expect(workspace).toContain("<Chat caseId={caseId} opts={opts} />");
    expect(workspace).not.toContain('<PageContainer variant="fixed">');
    expect(chat).toContain("<ChatWorkspace");
    expect(chat).not.toContain("<PageHeader");
    expect(chat).not.toContain("<PageContainer");
    // The frame bleeds the shell's WHOLE inset: `-mx-4 -my-6 sm:-mx-6` with `w-auto` is the
    // matched pair of CONTENT_INSET's `px-4 py-6 sm:px-6` (pinned above), so no canvas
    // strip shows beside the chat (Round 12, diagnosis/layout.md (h)), and the height is
    // the viewport minus the 3.5rem top bar, so the document never scrolls. `overflow-clip`
    // (never `hidden`): a clipped frame cannot be scrolled by a focus() or a contents jump.
    expect(frame).toContain(
      'className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] w-auto min-h-0 min-w-0 overflow-clip bg-background sm:-mx-6"',
    );
    expect(frame).toContain('<h1 className="sr-only">Chat</h1>');
    expect(history).toContain('aria-label="Chat history"');
  });

  it("uses one shared blocking-load grammar across case evidence panels", () => {
    for (const file of [
      "soc/pages/casedetail/WhyPanel.tsx",
      "soc/pages/casedetail/ThreatContextPanel.tsx",
      "soc/pages/casedetail/StageTimeline.tsx",
    ]) {
      const text = source(file);
      expect(text, `${file} must use the shared LoadingState`).toContain("<LoadingState");
      expect(text, `${file} must not invent a blocking Skeleton state`).not.toContain("<Skeleton");
    }
  });

  /**
   * Telemetry strips (Round 14, SPEC §4.9.2): a page's strip is the shared `KpiStrip`. Its
   * panel grid (`KpiTileGrid surface="panel"`) draws only the rules between two tiles, at
   * every column count, so a wrapped row never starts with a hanging divider; the strip
   * primitive's own tests pin that grammar. The hand-rolled `grid grid-cols-2 border-y`
   * strips of Cases, Metrics and Sources, whose row-start resets this gate once derived
   * from each strip's column counts, are gone, and none may come back on any page.
   */
  it("puts the telemetry strips on the shared KpiStrip, never a hand-rolled bordered grid", () => {
    const strips = ["soc/pages/Cases.tsx", "soc/pages/Metrics.tsx", "soc/pages/Sources.tsx"];
    expect(strips.length).toBeGreaterThan(0);
    for (const file of strips) {
      expect(source(file), `${file} must render its strip with the shared KpiStrip`).toMatch(/<KpiStrip\b/);
    }
    const pages = readdirSync(path.join(SRC, "soc/pages")).filter((name) => name.endsWith(".tsx"));
    expect(pages.length).toBeGreaterThan(0);
    for (const name of pages) {
      expect(
        source(`soc/pages/${name}`),
        `soc/pages/${name} must not hand-roll a bordered telemetry strip grid; use KpiStrip`,
      ).not.toMatch(/grid grid-cols-2 border-y border-border\/70/);
    }
  });
});
