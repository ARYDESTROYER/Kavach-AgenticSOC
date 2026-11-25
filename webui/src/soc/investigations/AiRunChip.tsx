/**
 * The case header chip "AI working · m:ss" or "AI queued", with its popover (Round 16
 * SPEC §4.3 WP01 stub; WP09 fills it). `compact` is the narrow-pane form. Until WP09
 * lands it renders nothing, so a mounted chip changes nothing.
 */
import type * as React from 'react';

export interface AiRunChipProps {
  caseId: string;
  compact?: boolean;
}

export const AiRunChip: React.FC<AiRunChipProps> = () => null;
