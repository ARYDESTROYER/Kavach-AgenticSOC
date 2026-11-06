import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { KpiTile, type KpiAccent } from './KpiTile';

/**
 * @deprecated `StatCard` was absorbed into `KpiTile` as `variant='bar'` (W0-D D1).
 * This is a THIN re-export kept for the one transition wave so existing call sites
 * (Metrics/Cost/Models/BatchJobs/Overview/BaselineGauge) keep working unchanged;
 * the Codemod wave migrates them to `<KpiTile variant="bar" .../>` directly.
 */
export type StatAccent = KpiAccent;

export interface StatCardProps {
  /** Metric label (plain text). */
  label: string;
  /** Big metric value (plain text / node). */
  value: React.ReactNode;
  /** Optional sub-line (e.g. "13 valid samples"). Plain text. */
  sub?: string;
  /** Left accent bar color. Defaults to 'primary'. */
  accent?: StatAccent;
  /** Optional trailing icon next to the label. */
  icon?: LucideIcon;
  className?: string;
}

/**
 * Big-metric card with a slim colored LEFT accent bar — used for MTTD / MTTA / MTTR
 * style timing metrics. Now a thin wrapper over `<KpiTile variant="bar">`; all text
 * plain (UNTRUSTED-safe).
 */
export const StatCard = React.forwardRef<HTMLElement, StatCardProps>(
  ({ label, value, sub, accent = 'primary', icon, className }, ref) => (
    <KpiTile
      ref={ref}
      variant="bar"
      // Round 14: the bordered tile with its accent bar is the framed chrome; StatCard
      // keeps it, so its callers render exactly as before.
      chrome="framed"
      label={label}
      value={value}
      sub={sub}
      accent={accent}
      icon={icon}
      className={className}
    />
  ),
);
StatCard.displayName = 'StatCard';

export default StatCard;
