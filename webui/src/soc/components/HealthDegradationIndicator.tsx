/** Degradation-only Agent-health warning for the Cyber Defence Center. */
import { AlertTriangle, ArrowRight } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { Navigate } from '@/soc/router';

import {
  healthDegradations,
  useHealthDiagnosticsData,
} from './health-diagnostics-state';

export interface HealthDegradationIndicatorProps {
  windowHours?: number;
  onNavigate?: Navigate;
  className?: string;
}

/**
 * Costs zero Overview space when every readable signal is healthy. A positively
 * detected degradation becomes one warning strip and one canonical drill-through;
 * unknown/unmeasured evidence remains available in Analytics without becoming a
 * fabricated incident.
 */
export function HealthDegradationIndicator({
  windowHours = 24,
  onNavigate,
  className,
}: HealthDegradationIndicatorProps) {
  const { health, autoClose } = useHealthDiagnosticsData(windowHours);
  const degradations = healthDegradations(health, autoClose);
  if (!degradations.length) return null;

  const summary = degradations.map((signal) => signal.label).join('; ');
  return (
    <section
      role="alert"
      aria-label="Agent health needs attention"
      data-testid="health-degradation-indicator"
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-y border-warning/30 bg-warning/5 px-3 py-2 text-warning-text',
        className,
      )}
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-xs font-medium">
        Agent health needs attention: {summary}.
      </p>
      {onNavigate ? (
        <button
          type="button"
          onClick={() => onNavigate('metrics', { tab: 'effectiveness' })}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View effectiveness
          <ArrowRight className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </section>
  );
}

export default HealthDegradationIndicator;
