/**
 * Experimental › Demo Mode: the Settings control (Round-2 Wave 5).
 *
 * Arms / re-seeds / exits the first-class, REVERSIBLE demo tenant (off | seeded |
 * live). Seeded loads a static synthetic history; live additionally simulates new
 * incidents on a tick. While armed, every read endpoint serves from an isolated
 * in-memory store ($0 mock LLM, sandboxed policy copy) so real cases are hidden and
 * the live durable cursor / stores / policy are untouched. Exiting hard-deletes the
 * synthetic data by run_id and restores the real state intact.
 *
 * This is a clearly-labelled EXPERIMENTAL control, gated by demo:manage. All
 * mutations refresh the shared <DemoProvider> so the shell banner / SAMPLE badges /
 * "(simulated)" cost suffix / muted health chip flip with it. Hooks live above any
 * early return (React #310). No secrets; synthetic data is a backend concern.
 */
import * as React from 'react';
import { FlaskConical, Play, RotateCcw, Siren } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { DemoConfig, DemoIncidentResult, DemoMode } from '@/lib/types';
import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';
import { useDemo } from '@/soc/demo';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { NumberField } from '@/soc/components/NumberField';
import { LabeledSlider } from '@/soc/components/LabeledSlider';
import { SectionTitle } from '@/soc/pages/settings/primitives';
import { StatusDot } from '@/design-system';

const MODES: Array<{ value: Exclude<DemoMode, 'off'>; label: string; help: string }> = [
  {
    value: 'seeded',
    label: 'Seeded',
    help: 'Load a static synthetic history (old + recent cases). Nothing changes after seeding.',
  },
  {
    value: 'live',
    label: 'Live',
    help: 'Recommended: seed history and continuously stream five native-format sources.',
  },
];

export function DemoModeSection() {
  const { status, active, refresh } = useDemo();

  // Draft knobs for ARMING demo (only consumed by enable()). Seed defaults to the
  // current run's seed when active so a Reset/re-enable is reproducible.
  const [mode, setMode] = React.useState<Exclude<DemoMode, 'off'>>('live');
  const [seed, setSeed] = React.useState<number>(1337);
  const [historyDays, setHistoryDays] = React.useState<number>(14);
  const [tickSeconds, setTickSeconds] = React.useState<number>(10);
  const [incidentRatePct, setIncidentRatePct] = React.useState<number>(5);
  const [alertIntervalSeconds, setAlertIntervalSeconds] = React.useState<number>(120);
  const [eventRatePerSecond, setEventRatePerSecond] = React.useState<number>(40);
  const [busy, setBusy] = React.useState<'enable' | 'incident' | 'reset' | 'disable' | null>(null);
  const [lastIncident, setLastIncident] = React.useState<DemoIncidentResult | null>(null);

  // When the live status changes (e.g. another tab armed it), reflect the seed so
  // the form mirrors the active run. Effect is unconditional (above any return).
  React.useEffect(() => {
    if (active) {
      if (typeof status.seed === 'number') setSeed(status.seed);
      if (typeof status.history_days === 'number') setHistoryDays(status.history_days);
      if (typeof status.tick_seconds === 'number') setTickSeconds(status.tick_seconds);
      if (typeof status.incident_rate === 'number')
        setIncidentRatePct(Math.round(status.incident_rate * 100));
      if (typeof status.alert_interval_seconds === 'number' && status.alert_interval_seconds > 0)
        setAlertIntervalSeconds(status.alert_interval_seconds);
      if (typeof status.event_rate_per_second === 'number')
        setEventRatePerSecond(status.event_rate_per_second);
      if (status.mode === 'live' || status.mode === 'seeded') setMode(status.mode);
    }
  }, [
    active, status.seed, status.history_days, status.tick_seconds, status.incident_rate,
    status.alert_interval_seconds, status.event_rate_per_second, status.mode,
  ]);

  const onEnable = React.useCallback(async () => {
    const config: DemoConfig = {
      mode,
      seed,
      history_days: historyDays,
      tick_seconds: tickSeconds,
      incident_rate: incidentRatePct / 100,
      alert_interval_seconds: alertIntervalSeconds,
      event_rate_per_second: eventRatePerSecond,
    };
    setBusy('enable');
    try {
      await api.demo.enable(config);
      setLastIncident(null);
      await refresh();
      toast.success(`Demo mode enabled (${mode}).`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not enable demo mode.');
    } finally {
      setBusy(null);
    }
  }, [
    mode, seed, historyDays, tickSeconds, incidentRatePct,
    alertIntervalSeconds, eventRatePerSecond, refresh,
  ]);

  const onReset = React.useCallback(async () => {
    setBusy('reset');
    try {
      await api.demo.reset();
      setLastIncident(null);
      await refresh();
      toast.success('Demo data re-seeded from the same seed.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reset demo data.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const onIncident = React.useCallback(async () => {
    setBusy('incident');
    try {
      const result = await api.demo.incident();
      setLastIncident(result);
      await refresh();
      if (result.triggered) {
        toast.success(
          `${result.scenario_name || 'Synthetic incident'}: ${result.native_alerts} native alert${result.native_alerts === 1 ? '' : 's'} + ${result.system_detections} Agentic SOC detection${result.system_detections === 1 ? '' : 's'}.`,
        );
      } else {
        const wait = Math.max(1, Math.ceil(result.cooldown_seconds || 0));
        toast.warning(
          result.cooldown_seconds > 0
            ? `The incident generator is cooling down. Try again in ${wait}s.`
            : result.reason || 'No incident was generated.',
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate a demo incident.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const onDisable = React.useCallback(async () => {
    setBusy('disable');
    try {
      await api.demo.disable();
      setLastIncident(null);
      await refresh();
      toast.success('Demo mode exited. Synthetic data cleared and your real state restored.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not exit demo mode.');
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  return (
    <div className="space-y-6" data-testid="demo-settings-surface">
      <SectionTitle
        title="Experimental & Demo"
        sub="Explore the complete console with an isolated, zero-cost, reversible synthetic dataset before connecting a live source."
        actions={active ? (
          <Badge variant="warning" className="gap-1">
            <FlaskConical className="h-3 w-3" aria-hidden />
            {status.mode === 'live'
              ? `Live · ${status.simulator_running ? 'streaming' : 'stopped'}`
              : 'Seeded · ready'}
          </Badge>
        ) : null}
      />

      {/* The safety contract: isolation, $0, reversibility. */}
      <Alert>
        <FlaskConical className="h-4 w-4" aria-hidden />
        <AlertTitle>Isolated, free, and fully reversible</AlertTitle>
        <AlertDescription>
          Demo data lives in a separate in-memory store and runs through a deterministic mock
          model, so it{' '}
          <strong className="font-semibold text-foreground">costs nothing</strong> and the
          deterministic close/escalate logic runs against a{' '}
          <strong className="font-semibold text-foreground">sandboxed policy copy</strong>, so
          your live policy is never changed by demo processing. While demo is on, your real
          cases are <strong className="font-semibold text-foreground">hidden</strong>, source
          controls are read-only, and outbound notification tests are refused. Other
          organization settings remain live, so leave them unchanged while presenting. Exiting{' '}
          <strong className="font-semibold text-foreground">hard-deletes</strong> the synthetic
          data and restores your real state exactly as it was. Demo-generated workload never
          touches the durable poll cursor or your real case stores.
        </AlertDescription>
      </Alert>

      {!active ? (
        <>
          {/* Mode picker */}
          <div className="space-y-3">
            <Label className="text-sm font-medium text-foreground">
              Mode
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {MODES.map((m) => {
                const selected = mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMode(m.value)}
                    aria-pressed={selected}
                    className={cn(
                      'rounded-md border px-4 py-3 text-left transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-surface hover:border-border/80',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span
                        role="img"
                        className={cn(
                          'inline-block h-2 w-2 rounded-full',
                          selected ? 'bg-primary' : 'bg-muted-foreground/40',
                        )}
                        aria-hidden
                      />
                      {m.label}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {m.help}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Knobs: shared NumberField (+/- steppers, clamp-on-blur) + LabeledSlider,
              matching Settings › Detection so the demo config uses the same primitives. */}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <NumberField
              label="History"
              unit="days"
              value={historyDays}
              min={0}
              max={90}
              onChange={setHistoryDays}
              description="Days of trailing synthetic history to pre-generate."
            />
            <NumberField
              label="Tick"
              unit="s"
              value={tickSeconds}
              min={1}
              max={60}
              onChange={setTickSeconds}
              description="Live mode only: how often a new synthetic batch arrives."
            />
            <NumberField
              label="Alert interval"
              unit="s"
              value={alertIntervalSeconds}
              min={1}
              max={3600}
              onChange={setAlertIntervalSeconds}
              description="Source-native alert cadence across Splunk, QRadar, and Wazuh."
            />
            <NumberField
              label="Event rate"
              unit="/s"
              value={eventRatePerSecond}
              min={0}
              max={200}
              onChange={setEventRatePerSecond}
              description="Logical five-source throughput; recent raw buffers stay bounded."
            />
            <NumberField
              label="Seed"
              value={seed}
              min={0}
              onChange={setSeed}
              description="Deterministic: the same seed reproduces the same data."
            />
            <LabeledSlider
              label="Incident rate"
              value={incidentRatePct}
              onChange={setIncidentRatePct}
              min={0}
              max={50}
              step={1}
              formatValue={(v) => `${v}%`}
              description="Chance at each alert interval of emitting a storyline instead."
            />
          </div>

          <Button onClick={() => void onEnable()} disabled={busy !== null}>
            <Play className="h-4 w-4" aria-hidden />
            {busy === 'enable' ? 'Enabling…' : 'Enable demo mode'}
          </Button>
        </>
      ) : (
        <>
          {/* Active summary */}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 sm:[&>*:nth-child(2n+1)]:border-l-0 lg:grid-cols-4 lg:[&>*:nth-child(2n+1)]:border-l lg:[&>*:nth-child(4n+1)]:border-l-0">
            <SummaryTile label="Mode" value={status.mode === 'live' ? 'Live' : 'Seeded'} />
            <SummaryTile label="Seed" value={String(status.seed ?? seed)} mono />
            <SummaryTile
              label="Sources"
              value={
                Array.isArray(status.sources) && status.sources.length > 0
                  ? String(status.sources.length)
                  : '4'
              }
            />
            <SummaryTile
              label="Synthetic cases"
              value={typeof status.case_count === 'number' ? status.case_count.toLocaleString() : DASH}
            />
          </div>

          {/* Live capability signal: "these features are working" (demo overhaul). */}
          <div>
            <Label className="text-sm font-medium text-foreground">
              Capabilities live
            </Label>
            <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 sm:[&>*:nth-child(2n+1)]:border-l-0 lg:grid-cols-4 lg:[&>*:nth-child(2n+1)]:border-l lg:[&>*:nth-child(4n+1)]:border-l-0">
              <SummaryTile
                label="HITL approvals"
                value={fmtCount(status.proposals_open)}
              />
              <SummaryTile
                label="Campaigns"
                value={fmtCount(status.campaigns_found)}
              />
              <SummaryTile
                label="Tuning observations"
                value={fmtCount(status.tuning_events)}
              />
              <SummaryTile
                label="RAG corpus"
                value={
                  typeof status.rag_chunks === 'number'
                    ? `${status.rag_chunks.toLocaleString()} chunks`
                    : DASH
                }
              />
            </div>
          </div>

          {Array.isArray(status.source_activity) && status.source_activity.length > 0 ? (
            <div>
              <Label className="text-sm font-medium text-foreground">
                Native source activity
              </Label>
              <div className="mt-3 divide-y divide-border border-y border-border sm:grid sm:grid-cols-2 sm:divide-y-0 sm:[&>*:nth-child(2n+1)]:border-l-0 xl:grid-cols-4 xl:[&>*:nth-child(2n+1)]:border-l xl:[&>*:nth-child(4n+1)]:border-l-0">
                {status.source_activity.map((source) => (
                  <div
                    key={source.source_id}
                    className="min-w-0 px-4 py-3 sm:border-l sm:border-border"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {source.display_name || source.source_id}
                      </p>
                      {/* A status only for the exception, in words beside its dot (never
                          colour alone, SPEC §4.9.2): a healthy source reads calm. */}
                      {source.healthy === false ? (
                        <StatusDot tone="critical" className="shrink-0 text-xs">
                          Degraded
                        </StatusDot>
                      ) : null}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {source.protocol || source.wire_format || source.source_type || 'Native feed'}
                    </p>
                    <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                      {fmtCount(source.events_total ?? 0)} event{source.events_total === 1 ? '' : 's'} ·{' '}
                      {fmtCount(source.alerts_total ?? 0)} native alert{source.alerts_total === 1 ? '' : 's'}
                      {(source.system_detections_total ?? 0) > 0
                        ? ` · ${fmtCount(source.system_detections_total)} Agentic SOC detection${source.system_detections_total === 1 ? '' : 's'}`
                        : ''}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {lastIncident ? (
            <Alert variant={lastIncident.triggered ? 'default' : 'warning'}>
              <Siren className="h-4 w-4" aria-hidden />
              <AlertTitle>
                {lastIncident.triggered
                  ? lastIncident.scenario_name || 'Synthetic incident generated'
                  : 'Incident not generated'}
              </AlertTitle>
              <AlertDescription>
                {lastIncident.triggered
                  ? `${lastIncident.events} native records across five sources produced ${lastIncident.native_alerts} vendor alert${lastIncident.native_alerts === 1 ? '' : 's'} and ${lastIncident.system_detections} Agentic SOC detection${lastIncident.system_detections === 1 ? '' : 's'}.`
                  : lastIncident.reason}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void onIncident()} disabled={busy !== null}>
              <Siren
                className={cn('h-4 w-4', busy === 'incident' && 'animate-pulse')}
                aria-hidden
              />
              {busy === 'incident' ? 'Generating…' : 'Generate incident'}
            </Button>
            <Button variant="outline" onClick={() => void onReset()} disabled={busy !== null}>
              <RotateCcw
                className={cn('h-4 w-4', busy === 'reset' && 'animate-spin')}
                aria-hidden
              />
              Reset (re-seed)
            </Button>
            <Button
              variant="outline"
              className="border-critical/40 text-critical hover:bg-critical/10 hover:text-critical"
              onClick={() => void onDisable()}
              disabled={busy !== null}
            >
              {busy === 'disable' ? 'Exiting…' : 'Exit & clear'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Render a best-effort capability count (falls back to a dash when absent). */
function fmtCount(n: number | undefined): string {
  return typeof n === 'number' ? n.toLocaleString() : DASH;
}

function SummaryTile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-l border-border pl-3" data-settings-metric="demo">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-sm font-semibold text-foreground', mono && 'font-mono')}>
        {value}
      </p>
    </div>
  );
}

export default DemoModeSection;
