/** One icon per release-note area (lazy: only What's new imports it). */
import {
  BookOpenText,
  Columns3,
  LayoutGrid,
  Library,
  MessageSquare,
  Radar,
  Server,
  Settings,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

import type { HighlightArea } from './notes';

export const AREA_ICON: Record<HighlightArea, LucideIcon> = {
  cases: Columns3,
  chat: MessageSquare,
  dashboards: LayoutGrid,
  detection: Radar,
  intelligence: Library,
  automation: Workflow,
  security: ShieldCheck,
  administration: Settings,
  platform: Server,
  help: BookOpenText,
};
