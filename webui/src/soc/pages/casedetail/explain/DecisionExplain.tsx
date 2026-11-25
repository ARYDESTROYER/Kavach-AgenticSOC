/**
 * The decision explainer (Round 16 SPEC §4.3 WP01 stub; WP11 fills it): the recorded
 * gate (verdict, confidence and risk against the auto-close policy in force) and a
 * "policy changed since" note. Until WP11 lands it renders its children.
 */
import type * as React from 'react';
import type { Case } from '@/lib/types';

export interface DecisionExplainProps {
  caseRecord: Case;
  children: React.ReactNode;
}

export const DecisionExplain: React.FC<DecisionExplainProps> = ({ children }) => <>{children}</>;
