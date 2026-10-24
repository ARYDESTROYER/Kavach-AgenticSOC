/**
 * Starter family id → lucide icon (SPEC-chat §5.2: "starter-icons.ts grows to every
 * family"). The ids are the server's family ids (`ChatStarter.id`): the signal and
 * evergreen families of §3.3, the onboarding card, the Case Manager chips of §3.14, and
 * the pre-Round-13 ids `GET /api/chat/context` used to serve. An unknown id gets the
 * neutral chat glyph rather than a guess. Icons are decorative (`aria-hidden`); the
 * question carries the meaning.
 */
import {
  Activity,
  BookOpen,
  Bookmark,
  CalendarDays,
  CircleHelp,
  ClipboardCheck,
  ClipboardList,
  Crosshair,
  FileSearch,
  FileText,
  FlaskConical,
  Gauge,
  Hourglass,
  Inbox,
  LineChart,
  Link2,
  ListChecks,
  MessageSquareMore,
  MessageSquareText,
  Network,
  Plug,
  Radar,
  ScanSearch,
  Siren,
  StickyNote,
  Sunrise,
  TrendingUp,
  UserCheck,
  UserSearch,
  Wallet,
  WifiOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const STARTER_ICONS: Readonly<Record<string, LucideIcon>> = {
  // Signals (§3.3).
  needs_human: Siren,
  my_cases: UserCheck,
  sla: Hourglass,
  new_cases: Inbox,
  volume_change: TrendingUp,
  noisy_rule: Radar,
  campaign: Network,
  silent_source: WifiOff,
  budget: Wallet,
  shift: Sunrise,
  weekly: CalendarDays,
  continue: MessageSquareMore,
  saved_prompt: Bookmark,
  hunt: Crosshair,
  approvals: ListChecks,
  platform: Activity,
  demo: FlaskConical,
  // Evergreen and onboarding.
  triage: ScanSearch,
  posture: Gauge,
  report: FileText,
  explain_metric: LineChart,
  learn_app: BookOpen,
  connect_source: Plug,
  // Case Manager chips (§3.14).
  case_needs_person: Siren,
  case_undecided: CircleHelp,
  case_closed_why: ClipboardCheck,
  case_entity: UserSearch,
  case_related: Link2,
  case_handoff: StickyNote,
  // Pre-Round-13 `/chat/context` ids.
  investigate: ScanSearch,
  shift_brief: ClipboardList,
  evidence: FileSearch,
};

export function starterIcon(id: string): LucideIcon {
  return Object.prototype.hasOwnProperty.call(STARTER_ICONS, id) ? STARTER_ICONS[id] : MessageSquareText;
}
