/**
 * BudgetCard — the LLM cost-budget ceiling editor + live spend gauge (Round 3 / F9).
 *
 * Reads GET /api/budget (the ceiling config) + GET /api/budget/status (the live rolling
 * daily/monthly spend vs the ceilings + band), edits the config (PUT /api/budget when
 * the user has `models:manage`), and visualises each window's spend-vs-cap with an
 * honest band-coloured fraction bar (the status payload has no per-bucket time series, so
 * we do not fabricate a burn-down trajectory).
 *
 * #3: a budget governs ONLY whether an LLM call RUNS (enforced in the gateway, which
 * fails to NEEDS_HUMAN) — it never alters case_manager.decide(). #9: all values here are
 * numeric / controlled labels, rendered as plain text.
 */
import * as React from 'react';
import { Gauge, Loader2, Save, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Skeleton } from '@/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { LoadError } from '@/soc/components/LoadError';
import {
  modelsApi,
  type BudgetConfig,
  type BudgetStatus,
  type BudgetWindowStatus,
} from '@/soc/pages/Models.api';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

const BAND_META: Record<string, { label: string; cls: string; bar: string }> = {
  ok: { label: 'OK', cls: 'text-success', bar: 'bg-success' },
  warn: { label: 'Warning', cls: 'text-warning', bar: 'bg-warning' },
  over: { label: 'Over', cls: 'text-critical', bar: 'bg-critical' },
};

/**
 * Parse a raw ceiling input into a budget cap. Empty/whitespace → `null` ("no limit");
 * a finite value ≥ 0 → that number; anything else (garbage / negative) keeps `prev` so a
 * bad partial entry never clobbers a set ceiling. Exported for tests.
 */
export function parseCeiling(raw: string, prev: number | null): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : prev;
}

/**
 * A USD ceiling input that keeps the RAW text while the operator is typing so
 * intermediate decimal states ("10.", "10.50") survive, and only parses + commits on
 * blur/Enter. A plain `<Input type="number">` bound to the parsed number re-derived the
 * value each keystroke, which stripped a trailing dot/zero and made decimals unenterable.
 */
function CeilingField({
  id,
  label,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  label: string;
  value: number | null;
  disabled?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = React.useState(value == null ? '' : String(value));
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    if (!editing) setText(value == null ? '' : String(value));
  }, [value, editing]);
  const commit = (raw: string) => {
    const next = parseCeiling(raw, value);
    setEditing(false);
    setText(next == null ? '' : String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        placeholder="no limit"
        value={text}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
        }}
      />
    </div>
  );
}

/** What a window says when the server withholds its spend (a viewer without `cost:view`). */
export const SPEND_WITHHELD = 'You do not have access to AI spend.';

function WindowRow({ label, w }: { label: string; w: BudgetWindowStatus }) {
  if (w.spent == null) {
    // Without cost:view the server leaves the spend, the fraction and the band out
    // (Round 14 second acceptance pass, roles-11): show the ceiling and say why, never a
    // band the viewer cannot have, which would read OK.
    return (
      <div className="space-y-2 rounded-md border border-border bg-surface p-4">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <div className="flex items-baseline justify-between gap-4 text-sm">
          <span className="text-muted-foreground">{SPEND_WITHHELD}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {w.cap != null ? `Ceiling ${fmtMoney(w.cap)}` : 'no ceiling'}
          </span>
        </div>
      </div>
    );
  }
  const band = (w.band != null ? BAND_META[w.band] : undefined) ?? BAND_META.ok;
  const pct = w.fraction != null ? Math.min(100, Math.max(0, w.fraction * 100)) : null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Badge
          variant={w.band === 'over' ? 'critical' : w.band === 'warn' ? 'warning' : 'success'}
        >
          {band.label}
        </Badge>
      </div>
      <div className="flex items-baseline justify-between text-sm tabular-nums">
        <span className="text-foreground">{fmtMoney(w.spent)}</span>
        <span className="text-xs text-muted-foreground">
          {w.cap != null ? `of ${fmtMoney(w.cap)}` : 'no ceiling'}
        </span>
      </div>
      {/* Honest spend-vs-cap gauge: a band-coloured bar of the fraction used. (There is
          no real per-bucket time series in the status payload, so we do NOT fabricate a
          burn-down trajectory that would imply spend-over-time it cannot show.) */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label} ${pct != null ? Math.round(pct) + '% of ceiling' : 'no ceiling'}`}>
        <div
          className={cn('h-full rounded-full transition-all', band.bar)}
          style={{ width: pct != null ? `${pct}%` : '0%' }}
        />
      </div>
    </div>
  );
}

export interface BudgetCardProps {
  canManage?: boolean;
}

export function BudgetCard({ canManage = true }: BudgetCardProps) {
  const [config, setConfig] = React.useState<BudgetConfig | null>(null);
  const [status, setStatus] = React.useState<BudgetStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, s] = await Promise.all([
        modelsApi.getBudget(),
        modelsApi.budgetStatus().catch(() => null),
      ]);
      setConfig(b.budget);
      if (s) setStatus(s);
      setDirty(false);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<BudgetConfig>) => {
    setConfig((c) => (c ? { ...c, ...p } : c));
    setDirty(true);
  };

  const save = async () => {
    if (!config) return;
    setBusy(true);
    try {
      const res = await modelsApi.putBudget(config);
      setConfig(res.budget);
      setDirty(false);
      toast.success('Budget saved.');
      // Refresh the live status against the new ceilings.
      const s = await modelsApi.budgetStatus().catch(() => null);
      if (s) setStatus(s);
    } catch (e) {
      toast.error(errMsg(e, 'Could not save the budget.'));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !config) {
    return (
      <div
        className="space-y-5 rounded-lg border border-border bg-card p-5"
        aria-busy
        aria-label="Loading budget"
      >
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-28" />
        </div>
        <Skeleton className="h-4 w-full" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (!config) {
    // A load failure (config never arrived) surfaces the shared error+retry panel
    // instead of silently rendering nothing.
    if (error) {
      return <LoadError error={error} title="Couldn't load the budget" onRetry={() => void load()} />;
    }
    return null;
  }

  return (
    <div className="space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Cost budget</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Enforce ceiling</span>
          <Switch
            checked={config.enabled}
            disabled={!canManage || busy}
            onCheckedChange={(v) => patch({ enabled: v })}
            aria-label="Enforce cost budget"
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        When enabled, the gateway compares rolling spend against these ceilings before each
        LLM call. A block fails the investigation to <strong>needs human</strong> — it never
        changes a case decision.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <CeilingField
          id="budget-daily"
          label="Daily ceiling (USD)"
          value={config.daily_usd}
          disabled={!canManage || busy}
          onCommit={(v) => patch({ daily_usd: v })}
        />
        <CeilingField
          id="budget-monthly"
          label="Monthly ceiling (USD)"
          value={config.monthly_usd}
          disabled={!canManage || busy}
          onCommit={(v) => patch({ monthly_usd: v })}
        />
        <div className="space-y-1.5">
          <Label htmlFor="budget-warn">Soft-warn at</Label>
          <Select
            value={String(config.soft_warn_pct)}
            onValueChange={(v) => patch({ soft_warn_pct: Number(v) })}
          >
            <SelectTrigger id="budget-warn" disabled={!canManage || busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.5, 0.6, 0.7, 0.8, 0.9].map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {Math.round(p * 100)}% of ceiling
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budget-exceed">On exceed</Label>
          <Select
            value={config.on_exceed}
            onValueChange={(v) => patch({ on_exceed: v as 'warn' | 'block' })}
          >
            <SelectTrigger id="budget-exceed" disabled={!canManage || busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warn">Warn only</SelectItem>
              <SelectItem value="block">Block further spend</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {config.on_exceed === 'block' && config.enabled ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Block mode will stop LLM spend when a ceiling is crossed; affected investigations
            route to needs-human.
          </span>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
            Save budget
          </Button>
        </div>
      ) : null}

      {/* --- Live burn-down --- */}
      {status ? (
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live spend
          </h3>
          {!status.enabled ? (
            <p className="text-sm text-muted-foreground">
              The budget is currently off — spend is tracked but never blocked.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <WindowRow label="Today" w={status.daily} />
            <WindowRow label="This month (30d)" w={status.monthly} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default BudgetCard;
