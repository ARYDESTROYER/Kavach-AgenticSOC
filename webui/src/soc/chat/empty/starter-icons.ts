/**
 * Starter id → lucide icon (SPEC §10.5). The ids are the server's fixed set
 * (investigate, hunt, posture, shift_brief, explain_metric, learn_app); an unknown
 * id gets the neutral chat glyph rather than a guess.
 */
import { BookOpen, ClipboardList, Crosshair, Gauge, LineChart, MessageSquareText, ScanSearch } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const STARTER_ICONS: Record<string, LucideIcon> = {
  investigate: ScanSearch,
  hunt: Crosshair,
  posture: Gauge,
  shift_brief: ClipboardList,
  explain_metric: LineChart,
  learn_app: BookOpen,
};

export function starterIcon(id: string): LucideIcon {
  return STARTER_ICONS[id] ?? MessageSquareText;
}
