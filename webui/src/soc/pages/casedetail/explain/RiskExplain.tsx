/**
 * The risk score explainer (Round 16 SPEC §4.3 WP01 stub; WP11 fills it from the
 * recorded `risk_breakdown.inputs`). Wraps the shown score: the hover line is the
 * weighted sum with the real numbers, the click panel the factor table. `variant="row"`
 * is the mouse-only HoverCard for a queue row (no focusable content; the row's
 * accessible name carries the score). Until WP11 lands it renders its children.
 */
import type * as React from 'react';
import type { RiskBreakdown } from '@/lib/types';

export interface RiskExplainProps {
  caseId: string;
  score: number | null | undefined;
  breakdown: RiskBreakdown | null | undefined;
  children: React.ReactNode;
  variant?: 'row';
}

export const RiskExplain: React.FC<RiskExplainProps> = ({ children }) => <>{children}</>;
