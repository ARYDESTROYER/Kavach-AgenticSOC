/**
 * TimelinePanel — the "what happened" narrative (task 5 split).
 *
 * Task 5 split the old merged "Timeline" tab into two: this panel is the CLEAN,
 * standalone "what happened" story — ONLY the six-stage <StageTimeline> narrative
 * (input → correlate → risk → triage → investigate → decide). The AI-assessment, the
 * pinned deterministic DecisionCard, and the full ReAct trace now live on the sibling
 * <InvestigationPanel> (the "Investigation" tab), so this tab reads as one uncluttered
 * chronological account of how one alert became a case.
 *
 * SECURITY (#9): this panel only composes the read-only <StageTimeline>, which renders
 * its own source/log-derived step bodies as plain text or inside an escaped CodeBlock.
 * Nothing here decides or mutates a case (#3).
 */
import * as React from 'react';
import { GitMerge } from 'lucide-react';

import type { TimelineStagesResponse } from '@/soc/pages/CaseDetail.api';

import { StageTimeline } from './StageTimeline';
import { CASE_MANAGER_PANEL_PADDING, type CasePanelPresentation } from './shared';

export interface TimelinePanelProps {
  /** FACTS — the six-stage pipeline narrative. */
  stages: TimelineStagesResponse | null;
  stagesLoading: boolean;
  stagesError: unknown;
  onRetryStages: () => void;
  presentation?: CasePanelPresentation;
  /** Case Manager's final timeline event deep-links to the existing Investigation tab. */
  onOpenInvestigation?: () => void;
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  stages,
  stagesLoading,
  stagesError,
  onRetryStages,
  presentation = 'default',
  onOpenInvestigation,
}) => {
  if (presentation === 'case-manager') {
    return (
      <div
        className={CASE_MANAGER_PANEL_PADDING}
        data-case-panel="timeline"
        data-presentation="case-manager"
      >
        <StageTimeline
          data={stages}
          loading={stagesLoading}
          error={stagesError}
          onRetry={onRetryStages}
          presentation="case-manager"
          onOpenInvestigation={onOpenInvestigation}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"
          aria-hidden
        >
          <GitMerge className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">What happened</h3>
          <p className="text-sm text-muted-foreground">
            Source-asserted facts + the deterministic engine steps: the story of how this
            alert became a case.
          </p>
        </div>
      </div>
      {/* StageTimeline carries its own padding + skeleton/error/empty states. */}
      <div className="rounded-lg border border-border bg-card">
        <StageTimeline
          data={stages}
          loading={stagesLoading}
          error={stagesError}
          onRetry={onRetryStages}
        />
      </div>
    </div>
  );
};

export default TimelinePanel;
