/**
 * Human labels for the console's semantic case enums (severity, lifecycle status, AI
 * verdict): the ONE wording the badges draw on screen (`badges.tsx`) and the files an
 * answer or a report is exported to (`chat/report/export/walker.ts` for Word, Excel,
 * Markdown and HTML, `chat/blocks/export-helpers.ts` for CSV and Copy data). A download
 * therefore says "True positive", "Needs human", "Critical" and "Escalated" where the
 * screen does, never `true_positive` or `needs_human`. Only the JSON export keeps the
 * raw values (it is the machine-readable copy).
 *
 * Pure: no React and no icons, so the chat blocks kit and the lazy export chunks can
 * import it without pulling in the badge components.
 */
import { DASH, humanizeToken } from '@/lib/format';

export type SeverityBand = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** The severity band words (the `SeverityBadge` text). */
export const SEVERITY_LABEL: Readonly<Record<SeverityBand, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const own = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);

/** The word for a stored severity band key ("critical" → "Critical"); null for anything else. */
export function severityLabel(value: string): string | null {
  const key = value.trim().toLowerCase();
  return own(SEVERITY_LABEL, key) ? SEVERITY_LABEL[key as SeverityBand] : null;
}

/**
 * The words for a case lifecycle status (the `StatusBadge` text). The legacy
 * NEEDS_HUMAN status reads "Open · awaiting analyst" (the F8 taxonomy).
 */
export function statusLabel(status: string): string {
  const key = status.trim().toLowerCase();
  if (key === 'needs_human') return 'Open · awaiting analyst';
  if (key === 'on_hold') return 'On hold';
  return humanizeToken(status);
}

/**
 * The words for an AI verdict or verdict-like value (the `VerdictBadge` text):
 * "true_positive" → "True positive", "needs_human" → "Needs human"; no verdict reads
 * "Unverdicted".
 */
export function verdictLabel(verdict: string | null | undefined): string {
  if (!verdict || verdict.trim().toLowerCase() === 'none') return 'Unverdicted';
  const words = humanizeToken(verdict);
  return words === DASH ? 'Unverdicted' : words;
}
