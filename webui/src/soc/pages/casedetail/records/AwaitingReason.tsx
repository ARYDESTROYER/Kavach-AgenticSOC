/**
 * Why a case is still waiting for an investigation (Round 16 SPEC §4.3 WP01 stub; WP14
 * fills it from `GET /api/cases/{id}/forwarding`: a deferred cap, below the risk floor,
 * or forwarding off). Until WP14 lands it renders nothing.
 */
import type * as React from 'react';
import type { Case } from '@/lib/types';

export interface AwaitingReasonProps {
  caseRecord: Case;
}

export const AwaitingReason: React.FC<AwaitingReasonProps> = () => null;
