/**
 * A small explainer for one fact of the case (Round 16 SPEC §4.5 WP11): priority,
 * severity, SLA, cost and the other numbers in the meta strip and the inspector, each
 * from a builder in `@/lib/explain/builders`. Hover or focus for the one-line formula,
 * click for the full arithmetic. With no explanation it renders its children unchanged.
 */
import * as React from 'react';

import { ExplainTrigger } from '@/design-system/explain';
import type { Explanation } from '@/lib/explain/types';

export interface FactExplainProps {
  explanation: Explanation | null;
  children: React.ReactNode;
}

export const FactExplain: React.FC<FactExplainProps> = ({ explanation, children }) => (
  <ExplainTrigger explanation={explanation}>{children}</ExplainTrigger>
);
