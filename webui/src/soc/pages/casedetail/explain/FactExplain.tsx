/**
 * A small explainer for one fact of the case (Round 16 SPEC §4.3 WP01 stub; WP11 fills
 * it): priority, severity, SLA, cost and the other numbers in the meta strip and the
 * inspector, each from a builder in `@/lib/explain/builders`. Until WP11 lands it
 * renders its children.
 */
import type * as React from 'react';
import type { Explanation } from '@/lib/explain/types';

export interface FactExplainProps {
  explanation: Explanation | null;
  children: React.ReactNode;
}

export const FactExplain: React.FC<FactExplainProps> = ({ children }) => <>{children}</>;
