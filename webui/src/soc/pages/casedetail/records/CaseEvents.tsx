/**
 * The raw events behind a case (Round 16 SPEC §4.3 WP01 stub; WP14 fills it from
 * `GET /api/cases/{id}/events`): a compact table, a side sheet with Table and JSON tabs,
 * Copy, an NDJSON download and "Open in Logs". `filterEventIds` narrows the table to the
 * events one finding cites; `onClearFilter` clears it. Every value is source-controlled
 * and rendered as text (#9). Until WP14 lands it renders nothing.
 */
import type * as React from 'react';

export interface CaseEventsProps {
  caseId: string;
  filterEventIds?: string[] | null;
  onClearFilter?: () => void;
}

export const CaseEvents: React.FC<CaseEventsProps> = () => null;
