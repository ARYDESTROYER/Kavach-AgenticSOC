/**
 * The queue row mark: the turning ring and "AI working" or "AI queued" in the row's
 * status node (Round 16 SPEC §4.3 WP01 stub; WP09 fills it). It never sits in the case
 * chat glyph slot, so a row can show both. Until WP09 lands it renders nothing.
 */
import type * as React from 'react';

export interface AiRunMarkProps {
  caseId: string;
}

export const AiRunMark: React.FC<AiRunMarkProps> = () => null;
