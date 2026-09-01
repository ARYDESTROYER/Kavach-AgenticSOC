/**
 * Source-level guard for the Console page-anatomy contract.
 *
 * Runtime tests cover the individual workflows; this guard prevents a routed surface
 * from quietly re-introducing a private width/header/motion grammar. Host-tab pages own
 * the shared PageContainer/PageHeader while their child panels remain embeddable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");

const PRIMARY_SURFACES = [
  "soc/pages/Analytics.tsx",
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
  "soc/pages/Scans.tsx",
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
    expect(manager).toContain("w-auto sm:-mx-2 lg:-mx-4");
    expect(manager).toContain("2xl:-mx-8");
    expect(manager).toContain('role="separator"');

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

  it("lets Workspace Chat own one fluid route container without a detached embedded toolbar", () => {
    const workspace = source("soc/pages/Workspace.tsx");
    const chat = source("soc/pages/Chat.tsx");
    const history = source("soc/components/ChatHistoryRail.tsx");

    expect(workspace).not.toContain('<PageContainer variant="fixed">');
    expect(workspace).toContain("return <Chat caseId={caseId} />");
    expect(chat).toContain('variant="fluid"');
    expect(workspace).not.toContain("<Chat embedded");
    expect(chat).toContain("actions={actions}");
    expect(chat).toContain("<ChatHistoryRail");
    expect(history).toContain('aria-label="Conversation history"');
    expect(chat).toContain('presentation="workspace"');
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
   * Flat telemetry strips: the divider contract, derived from each strip's OWN column
   * counts rather than pinned to one hand-written token.
   *
   * A hairline separates neighbouring cells and must be OFF at the start of every row.
   * The previous gate only looked at the `xl:` token, still admitted `:first-child`
   * (which states the contract only while the strip happens to fit exactly one row),
   * and never checked that N matched the column count — so it stayed green while a
   * seventh Cases tile hung a hairline off the left edge of the third row at every
   * width from 640px to 1279px.
   *
   * It could not have caught it in that shape either: the tokens were individually
   * plausible and the defect lived in the CASCADE. `[&>*:nth-child(odd)]:border-l` and
   * `[&>*:nth-child(3n+1)]:border-l-0` are both specificity (0,2,0), Tailwind emits
   * `border-l-0` before `border-l`, so for a cell that is BOTH odd and 3n+1 the enable
   * won — and the un-scoped `sm:` reset leaked upward and stripped a mid-row divider at
   * the widest breakpoint. Order, not intent, decided the render.
   *
   * So the enforced grammar removes the tie instead of describing it: every declared
   * column count owns a MUTUALLY EXCLUSIVE breakpoint range containing exactly one
   * ENABLE (`[&>*]:border-l`, specificity (0,1,0)) and one ROW-START RESET
   * (`[&>*:nth-child(Nn+1)]:border-l-0`, (0,2,0)) whose N is that range's own
   * `grid-cols-N`. The reset then wins on specificity alone, so the rendered result is
   * independent of emission order, and a strip that grows a tile changes only its
   * column count.
   */
  const BREAKPOINTS = ["sm", "md", "lg", "xl", "2xl"] as const;

  /**
   * The class text that declares ONE strip's columns and dividers.
   *
   * Comments are stripped first — the strips carry long notes that quote the very
   * class shapes this gate bans — and the window is cut at the next `grid grid-cols-`
   * so a neighbouring grid's column count can never be read as this strip's.
   */
  function stripChunk(file: string, anchor: string): string {
    const text = source(file);
    const at = text.indexOf(anchor);
    expect(at, `${file} no longer declares the flat telemetry strip "${anchor}"`).toBeGreaterThan(
      -1,
    );
    const raw = text
      .slice(at, at + 2600)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const nextGrid = raw.indexOf("grid grid-cols-", 1);
    return nextGrid > 0 ? raw.slice(0, nextGrid) : raw;
  }

  /** `[{ scope, cols }]` — one entry per declared column count, widest last. */
  function columnPlan(chunk: string): Array<{ scope: string; cols: number }> {
    const base = chunk.match(/(?:^|[\s'"`])grid-cols-(\d+)/);
    const declared: Array<{ bp: string | null; cols: number }> = [];
    if (base) declared.push({ bp: null, cols: Number(base[1]) });
    for (const bp of BREAKPOINTS) {
      const m = chunk.match(new RegExp(`\\b${bp}:grid-cols-(\\d+)`));
      if (m) declared.push({ bp, cols: Number(m[1]) });
    }
    return declared.map((entry, i) => {
      const next = declared[i + 1]?.bp;
      const from = entry.bp ? `${entry.bp}:` : "";
      // The LAST range is open-ended; every earlier one is capped at the next
      // breakpoint so two column counts can never both apply to one width.
      const scope = next ? `${from}max-${next}:` : from;
      return { scope, cols: entry.cols };
    });
  }

  it("resets row-start dividers when flat telemetry strips wrap", () => {
    const strips = [
      { file: "soc/pages/Cases.tsx", anchor: "grid grid-cols-2 border-y border-border/70 sm:" },
      { file: "soc/pages/Metrics.tsx", anchor: "grid grid-cols-2 border-y border-border/70 sm:" },
      { file: "soc/pages/Sources.tsx", anchor: "grid grid-cols-2 border-y border-border/70 sm:" },
    ];

    for (const { file, anchor } of strips) {
      const chunk = stripChunk(file, anchor);
      const plan = columnPlan(chunk);
      expect(plan.length, `${file} strip declares no column counts`).toBeGreaterThan(1);

      for (const { scope, cols } of plan) {
        expect(
          chunk,
          `${file} strip must enable the column rule for its ${cols}-column range`,
        ).toContain(`${scope}[&>*]:border-l`);
        expect(
          chunk,
          `${file} strip must clear the column rule at the start of every ${cols}-column row`,
        ).toContain(`${scope}[&>*:nth-child(${cols}n+1)]:border-l-0`);
      }

      // Order-dependent forms, banned outright: `:first-child` states the contract only
      // for a strip that never wraps, and an `odd`/`Nn+1` pair is a (0,2,0) tie whose
      // winner is decided by Tailwind's emission order rather than by this grammar.
      expect(chunk, `${file} strip must not gate a divider on :first-child`).not.toMatch(
        /\[&>\*:first-child\]:border-l/,
      );
      expect(chunk, `${file} strip must not gate a divider on :nth-child(odd)`).not.toMatch(
        /\[&>\*:nth-child\(odd\)\]:border-l/,
      );
    }
  });
});
