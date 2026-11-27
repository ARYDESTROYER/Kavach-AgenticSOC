/**
 * TimelinePanel: the "what happened" narrative (task 5 split).
 *
 * The six-stage <StageTimeline> narrative (input → correlate → risk → triage →
 * investigate → decide). Since Round 16 (SPEC D8) it has two homes, and owns the content
 * rail of neither:
 *
 *   - the Brief's folded "How this case was built": every stage, the one place where the
 *     source, AI and code lanes meet;
 *   - Evidence's "What happened": only the ingestion stage (`kinds={['input']}`), the
 *     source evidence blocks, so the source lane never shows the AI's or the code's work.
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
  /** The final timeline event deep-links to the AI investigation tab. */
  onOpenInvestigation?: () => void;
  /** Only these stage kinds (Evidence shows the `input` stage); omitted shows every stage. */
  kinds?: readonly string[];
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  stages,
  stagesLoading,
  stagesError,
  onRetryStages,
  onOpenInvestigation,
  kinds,
}) => {
  const shown = React.useMemo<TimelineStagesResponse | null>(() => {
    if (!stages || !kinds) return stages;
    const kept = (Array.isArray(stages.stages) ? stages.stages : []).filter((stage) =>
      kinds.includes(String(stage?.kind)),
    );
    return { ...stages, stages: kept, total: kept.length };
  }, [stages, kinds]);
  // Narrowed to stages a case has not reached yet: nothing to show, and no empty state
  // that would claim the whole story is missing.
  if (kinds && stages && shown && shown.stages.length === 0 && !stagesLoading && !stagesError) return null;
  return (
    // No padding of its own: it is a section of a tab, which owns the content rail.
    <div data-case-panel="timeline" data-presentation="case-manager" data-stage-kinds={kinds ? kinds.join(' ') : undefined}>
      <StageTimeline
        data={shown}
        loading={stagesLoading}
        error={stagesError}
        onRetry={onRetryStages}
        onOpenInvestigation={onOpenInvestigation}
      />
    </div>
  );
};

export default TimelinePanel;
