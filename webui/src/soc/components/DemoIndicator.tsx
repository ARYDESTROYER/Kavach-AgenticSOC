/**
 * Demo-mode indicator — the compact top-bar chip that replaced the full-width
 * DemoBanner (R12).
 *
 * The banner sat above the routed content on EVERY page and consumed ~6.5rem of
 * full-width vertical real estate. Demo is a safety-relevant state, so it must stay
 * unmistakable — but "unmistakable" is a matter of PLACEMENT, not size. This chip
 * lives in the shell's right cluster next to the release badge (identity/safety
 * chips grouped together) at EVERY breakpoint, including mobile: it is never folded
 * into the compact-controls Sheet, because a safety state is not a secondary utility.
 *
 * Nothing the banner offered was dropped — the isolation statement, the run summary,
 * and the two reversible exits (Reset re-seeds from the same seed; Exit & clear stops
 * the tick and hard-deletes the synthetic data) moved into a Popover, the same
 * click-to-explain pattern the release badge and the health pill already use in that
 * cluster. The mutations stay gated on `demo:manage`; a viewer without the grant still
 * sees the full safety copy.
 *
 * ONE chip says "Demo mode". While demo is active the shell mutes platform health
 * (the demo store is a throwaway in-memory one, so store warnings are expected) and
 * shows no health pill in the bar: the muted health is part of THIS chip's story, told
 * in its popover. A real backend outage still shows the health pill beside it.
 *
 * A11Y — ONE announcement: with the health pill out of the bar, the shell passes
 * `announce` and this chip is the single polite announcer of the demo state at every
 * width. On a narrow top bar the label folds away (container query on the bar,
 * `@container/topbar`): the flask icon stays, with a tooltip and the full accessible
 * name.
 *
 * Reads/writes go through the shared <DemoProvider>; on success it refreshes the
 * context so the rest of the console (cases store, cost suffix, health chip) flips
 * with it. Nothing here renders when demo is off.
 */
import * as React from 'react';
import { FlaskConical, RotateCcw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { badgeVariants } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/cn';
import { useDemo } from '@/soc/demo';
import type { Navigate } from '@/soc/router';
import { TOP_BAR_FOLD_HIDDEN } from '@/soc/top-bar-fold';
import { useCan } from './Can';

export interface DemoIndicatorProps {
  /** Shell navigation, used for the "Manage demo mode" deep-link into Settings. */
  onNavigate?: Navigate;
  /**
   * Make this chip the polite live region for the demo state. The shell passes it at
   * every width: while demo is on, the health pill is not in the bar, so exactly one
   * live region announces the state.
   */
  announce?: boolean;
}

export const DemoIndicator: React.FC<DemoIndicatorProps> = ({ onNavigate, announce = false }) => {
  const { status, active, refresh } = useDemo();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<'reset' | 'disable' | null>(null);
  const canManage = useCan('demo', 'manage');

  const onReset = React.useCallback(async () => {
    setBusy('reset');
    try {
      await api.demo.reset();
      await refresh();
      toast.success('Demo data re-seeded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reset demo data.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const onDisable = React.useCallback(async () => {
    setBusy('disable');
    try {
      await api.demo.disable();
      await refresh();
      toast.success('Demo mode exited. Synthetic data cleared.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not exit demo mode.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  if (!active) return null;

  const modeLabel = status.mode === 'live' ? 'live simulation' : 'seeded';
  const rows: Array<[string, string]> = [
    ['Mode', status.mode === 'live' ? 'Live simulation' : 'Seeded'],
    ...(typeof status.seed === 'number' ? ([['Seed', String(status.seed)]] as Array<[string, string]>) : []),
    ...(typeof status.case_count === 'number'
      ? ([['Synthetic cases', String(status.case_count)]] as Array<[string, string]>)
      : []),
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Its own provider: a tooltip must never be the reason a safety chip fails to
          mount, wherever the chip is rendered (the shell, or alone in a test). */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="demo-indicator"
                aria-label="Demo mode active, synthetic data"
                aria-live={announce ? 'polite' : undefined}
                className={cn(
                  badgeVariants({ variant: 'warning' }),
                  'h-7 shrink-0 gap-1.5 whitespace-nowrap font-normal hover:bg-warning/15',
                )}
              >
                <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {/* The label shows only where the top bar has room (62rem of bar, and it
                    folds last when the bar is crowded); outside the bar there is no
                    `topbar` container and the chip stays compact. */}
                <span className={cn('hidden @[62rem]/topbar:inline', TOP_BAR_FOLD_HIDDEN.demo)}>
                  Demo mode
                </span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Demo mode</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] space-y-3 text-xs leading-relaxed"
      >
        <div>
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Demo mode active (simulated data)
          </p>
          <p className="mt-1 text-muted-foreground">
            You are viewing a fully isolated {modeLabel} dataset. Real cases are hidden and
            nothing here costs money or touches your real cases or cursors. Disabling restores
            your real state intact.
          </p>
          <p className="mt-1 text-muted-foreground" data-testid="demo-indicator-health-note">
            Platform health checks are muted while demo mode is on: its data lives in a
            throwaway in-memory store, so store warnings are expected. A backend outage still
            shows in the top bar.
          </p>
        </div>

        <dl className="space-y-1.5 border-t border-border pt-3">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-w-0 items-start justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-all text-right font-mono text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-warning/50 text-warning-text hover:bg-warning/10"
              onClick={() => void onReset()}
              disabled={busy !== null}
            >
              <RotateCcw
                className={cn('h-3.5 w-3.5', busy === 'reset' && 'animate-spin')}
                aria-hidden
              />
              Reset
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-warning/50 text-warning-text hover:bg-warning/10"
              onClick={() => void onDisable()}
              disabled={busy !== null}
            >
              {busy === 'disable' ? 'Exiting…' : 'Exit & clear'}
            </Button>
            {onNavigate ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 font-normal text-muted-foreground"
                onClick={() => {
                  setOpen(false);
                  onNavigate('settings', { section: 'demo' });
                }}
              >
                <Settings2 className="h-3.5 w-3.5" aria-hidden />
                Manage demo mode
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-muted-foreground">
            Resetting or exiting demo mode needs the demo management permission.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default DemoIndicator;
