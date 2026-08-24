/**
 * Demo mode React context for the SOC console (Round-2 Wave 5).
 *
 * A single, app-wide source of truth for the demo tenant state (off | seeded |
 * live). It polls GET /api/demo/status on an interval and re-fetches on demand
 * (after enable/reset/disable, or on navigation) so every surface — the shell's
 * top-bar demo chip, the SAMPLE badge on demo rows, the "(simulated)" cost suffix,
 * the muted health chip, and the destructive-action guard — reflects the live state.
 *
 * BACK-COMPAT / ISOLATION: when demo is OFF (the default) every value here is inert:
 * `active` is false, `useDemoGuard()` returns "not guarded", and nothing renders. A
 * failed status fetch is swallowed (treated as OFF) so a backend without the demo
 * endpoints (or auth without the grant) never breaks the console. Synthetic data is
 * a backend concern; this context only reads NON-secret status metadata.
 */
import * as React from 'react';
import { api } from '@/lib/api';
import type { DemoStatus } from '@/lib/types';

/** Poll cadence for the demo status (ms). Cheap GET; demo is a rare, opt-in state. */
const POLL_MS = 20_000;

const OFF: DemoStatus = { mode: 'off', active: false, run_id: null };

export interface DemoContextValue {
  /** The live demo status (defaults to an OFF stub before the first fetch). */
  status: DemoStatus;
  /** True when the demo tenant is active (mode !== 'off'). */
  active: boolean;
  /** Whether the initial status fetch is still in flight. */
  loading: boolean;
  /** Re-fetch GET /api/demo/status now (call after enable/reset/disable + on nav). */
  refresh: () => Promise<DemoStatus>;
}

const DemoContext = React.createContext<DemoContextValue | null>(null);

/** True when a status indicates the demo tenant is active. */
export function isDemoActive(status: DemoStatus | null | undefined): boolean {
  if (!status) return false;
  if (typeof status.active === 'boolean') return status.active;
  return status.mode !== 'off';
}

export const DemoProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = React.useState<DemoStatus>(OFF);
  const [loading, setLoading] = React.useState(true);
  const aliveRef = React.useRef(true);

  const refresh = React.useCallback(async (): Promise<DemoStatus> => {
    let next: DemoStatus = OFF;
    try {
      next = await api.demo.status();
    } catch {
      // No demo endpoint / no grant / backend down → treat as OFF (inert).
      next = OFF;
    }
    if (aliveRef.current) setStatus(next);
    return next;
  }, []);

  React.useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      await refresh();
      if (aliveRef.current) setLoading(false);
    })();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(t);
    };
  }, [refresh]);

  const value = React.useMemo<DemoContextValue>(
    () => ({ status, active: isDemoActive(status), loading, refresh }),
    [status, loading, refresh],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
};

/**
 * Access the demo context. Returns an inert OFF value when used outside a provider
 * (so leaf components — e.g. badges in isolated tests — never throw). Surfaces that
 * own demo controls should still be mounted under <DemoProvider>.
 */
export function useDemo(): DemoContextValue {
  const ctx = React.useContext(DemoContext);
  if (ctx) return ctx;
  return { status: OFF, active: false, loading: false, refresh: async () => OFF };
}

export interface DemoGuard {
  /** True while the demo tenant is active (so real-write actions must be blocked). */
  active: boolean;
  /** True when a real-destructive action should be DISABLED right now. */
  disabled: boolean;
  /** A tooltip/aria reason to show on a disabled control. */
  reason: string;
}

/**
 * Gate a real-destructive action (running a real connector, changing live policy,
 * sending real notifications, …) while demo mode is active. In demo, such actions
 * would touch REAL stores/sources and must be disabled with an explanatory tooltip;
 * when demo is off the guard is fully inert.
 *
 * Usage — wire `disabled`/`reason` onto the trigger's disabled + title/aria-disabled:
 *   const guard = useDemoGuard();
 *   <Button
 *     disabled={guard.disabled}
 *     aria-disabled={guard.disabled || undefined}
 *     title={guard.disabled ? guard.reason : undefined}
 *     onClick={guard.disabled ? undefined : run}
 *   >Run</Button>
 */
export function useDemoGuard(): DemoGuard {
  const { active } = useDemo();
  return React.useMemo<DemoGuard>(() => {
    const reason = 'Disabled in demo mode — real actions are blocked while simulated data is active.';
    return {
      active,
      disabled: active,
      reason,
    };
  }, [active]);
}
