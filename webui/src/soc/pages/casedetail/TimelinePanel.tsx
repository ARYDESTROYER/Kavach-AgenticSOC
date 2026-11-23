/**
 * TimelinePanel: the "what happened" narrative (task 5 split).
 *
 * The "what happened" story: ONLY the six-stage <StageTimeline> narrative (input →
 * correlate → risk → triage → investigate → decide). Since Round 15 (D8.3) it is the
 * "What happened" section of the Overview tab, which owns its heading and the content
 * rail; the AI assessment,
 * the decision and the full ReAct trace live on <InvestigationPanel>, so the section
 * reads as one uncluttered chronological account of how one alert became a case.
 *
 * SECURITY (#9): this panel only composes the read-only <StageTimeline>, which renders
 * its own source/log-derived step bodies as plain text or inside an escaped CodeBlock.
 * Nothing here decides or mutates a case (#3).
 */
import * as React from 'react';

import type { TimelineStagesResponse } from '@/soc/pages/CaseDetail.api';

import { StageTimeline } from './StageTimeline';

export interface TimelinePanelProps {
  /** FACTS: the six-stage pipeline narrative. */
  stages: TimelineStagesResponse | null;
  stagesLoading: boolean;
  stagesError: unknown;
  onRetryStages: () => void;
  /** Case Manager's final timeline event deep-links to the existing Investigation tab. */
  onOpenInvestigation?: () => void;
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  stages,
  stagesLoading,
  stagesError,
  onRetryStages,
  onOpenInvestigation,
}) => {
  return (
    // No padding of its own: it is a section of the Overview, which owns the content rail.
    <div data-case-panel="timeline" data-presentation="case-manager">
      <StageTimeline
        data={stages}
        loading={stagesLoading}
        error={stagesError}
        onRetry={onRetryStages}
        onOpenInvestigation={onOpenInvestigation}
      />
    </div>
  );
};

export default TimelinePanel;
