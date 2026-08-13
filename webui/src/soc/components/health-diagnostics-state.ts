/**
 * Shared Agent-health state and degradation authority.
 *
 * Overview's degradation-only strip and Analytics' full HealthDiagnostics panel
 * must never disagree. Both consume this one reducer and this one permission-aware,
 * parameter-keyed loader. Unknown/unmeasured signals remain distinct from detected
 * degradation; they are explained by the full panel but never promoted to a false
 * incident warning.
 */
import * as React from 'react';

import { api } from '@/lib/api';
import type { AutoCloseHealth, DiagnosticsHealth } from '@/lib/types';
import { useCan } from '@/soc/components/Can';

export type HealthStatusTone =
  | 'critical'
  | 'warning'
  | 'secondary'
  | 'outline'
  | 'success';

/** The label + badge tone for one auto-close status. */
export interface AutoCloseStatusView {
  label: string;
  tone: HealthStatusTone;
  /** True when the status is a POSITIVELY DETECTED problem (not merely unmeasured). */
  problem: boolean;
  /** True when the status means "we could not measure this" — never a health claim. */
  unmeasured: boolean;
}

/**
 * Map the backend's explicit auto-close `status` onto operator-facing copy.
 *
 * `no_volume` and `insufficient_evidence` are absence of a measurement and are
 * never folded into either healthy or degraded.
 */
export function autoCloseStatusView(status: string | undefined | null): AutoCloseStatusView {
  switch ((status ?? '').trim()) {
    case 'collapsed':
      return { label: 'Collapsed', tone: 'critical', problem: true, unmeasured: false };
    case 'degraded':
      return { label: 'Degraded', tone: 'warning', problem: true, unmeasured: false };
    case 'never_fired':
      return { label: 'Never fired', tone: 'warning', problem: true, unmeasured: false };
    case 'disabled':
      return { label: 'Turned off', tone: 'secondary', problem: false, unmeasured: false };
    case 'no_volume':
      return {
        label: 'Not measured — no volume',
        tone: 'outline',
        problem: false,
        unmeasured: true,
      };
    case 'insufficient_evidence':
      return {
        label: 'Not measured — insufficient evidence',
        tone: 'outline',
        problem: false,
        unmeasured: true,
      };
    case 'ok':
      return {
        label: 'Measured — within tolerance',
        tone: 'success',
        problem: false,
        unmeasured: false,
      };
    default:
      return { label: 'Not measured', tone: 'outline', problem: false, unmeasured: true };
  }
}

export interface HealthDegradation {
  id: string;
  label: string;
  severity: 'critical' | 'warning';
  detail: string;
  remediation: string;
}

/**
 * The one degradation reducer shared by Overview and the full Analytics panel.
 *
 * Direct fields make the four load-bearing categories visible even to a trimmed
 * fixture that omits the roll-up `alerts` list. Remaining backend-detected alerts
 * (for example a collapsed RAG projection) are preserved without re-deriving any
 * backend threshold in the browser.
 */
export function healthDegradations(
  health: DiagnosticsHealth | null,
  autoClose: AutoCloseHealth | null,
): HealthDegradation[] {
  const found = new Map<string, HealthDegradation>();
  const corpus = health?.precedent_corpus;
  const migration = health?.schema_migration;
  const ac = autoClose ?? health?.auto_close ?? null;

  if (
    corpus?.starved ||
    (corpus?.zero_analyst_confirmed_precedents && corpus.status !== 'disabled')
  ) {
    found.set('precedent_corpus_starved', {
      id: 'precedent_corpus_starved',
      label: corpus.zero_analyst_confirmed_precedents
        ? 'No analyst-confirmed precedents'
        : 'Precedent corpus is starved',
      severity: 'critical',
      detail: corpus.status_reason || corpus.reason || '',
      remediation:
        'Confirm analyst case outcomes and verify the resolved-case precedent source.',
    });
  }

  if (migration?.failed) {
    found.set('sql_schema_migration_failed', {
      id: 'sql_schema_migration_failed',
      label: 'State-schema migration failed',
      severity: 'critical',
      detail: migration.detail || migration.reason || '',
      remediation: migration.remediation || '',
    });
  }

  const autoCloseView = autoCloseStatusView(ac?.status);
  if (autoCloseView.problem || ac?.needs_attention) {
    const status = (ac?.status ?? '').trim();
    const label =
      status === 'collapsed'
        ? 'Auto-close rate collapsed'
        : status === 'never_fired'
          ? 'Auto-close has never fired'
          : status === 'degraded'
            ? 'Auto-close rate is outside tolerance'
            : 'Auto-close health needs attention';
    found.set(`auto_close_${status || 'attention'}`, {
      id: `auto_close_${status || 'attention'}`,
      label,
      severity: status === 'collapsed' ? 'critical' : 'warning',
      detail: ac?.reason || '',
      remediation:
        status === 'collapsed' || status === 'never_fired'
          ? 'Check the precedent corpus, investigation path, and auto-close policy thresholds.'
          : '',
    });
  }

  for (const finding of health?.alerts ?? []) {
    // An explicit backend alert enriches/replaces the direct-field fallback with
    // its authoritative operator copy while retaining the same canonical id.
    found.set(finding.id, {
      id: finding.id,
      label: finding.title,
      severity: finding.severity === 'critical' ? 'critical' : 'warning',
      detail: finding.detail,
      remediation: finding.remediation,
    });
  }

  return [...found.values()].sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'critical' ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

interface HealthSnapshot {
  key: string | null;
  health: DiagnosticsHealth | null;
  autoClose: AutoCloseHealth | null;
  busy: boolean;
}

export interface HealthDiagnosticsData {
  health: DiagnosticsHealth | null;
  autoClose: AutoCloseHealth | null;
  busy: boolean;
  reload: () => Promise<void>;
}

/**
 * Load the two independently permissioned health signals without stale-window races.
 * A retained timer callback always reads the latest refs, superseded requests abort,
 * and a response is publishable only under the key for which it was issued.
 */
export function useHealthDiagnosticsData(windowHours = 24): HealthDiagnosticsData {
  const canDiagnostics = useCan('settings', 'read');
  const canMetrics = useCan('metrics', 'view');
  const hasDiagnosticsMethod = typeof api.diagnosticsHealth === 'function';
  const hasAutoCloseMethod = typeof api.autoCloseHealth === 'function';
  const requestKey = [
    windowHours,
    canDiagnostics && hasDiagnosticsMethod ? 'diagnostics' : '-',
    canMetrics && hasAutoCloseMethod ? 'metrics' : '-',
  ].join(':');

  const paramsRef = React.useRef({
    windowHours,
    requestKey,
    readDiagnostics: canDiagnostics && hasDiagnosticsMethod,
    readAutoClose: canMetrics && hasAutoCloseMethod,
  });
  paramsRef.current = {
    windowHours,
    requestKey,
    readDiagnostics: canDiagnostics && hasDiagnosticsMethod,
    readAutoClose: canMetrics && hasAutoCloseMethod,
  };

  const currentKeyRef = React.useRef(requestKey);
  currentKeyRef.current = requestKey;
  const requestIdRef = React.useRef(0);
  const controllerRef = React.useRef<AbortController | null>(null);
  const mountedRef = React.useRef(true);
  const [snapshot, setSnapshot] = React.useState<HealthSnapshot>({
    key: null,
    health: null,
    autoClose: null,
    busy: false,
  });

  const run = React.useCallback(async () => {
    const issued = paramsRef.current;
    const requestId = (requestIdRef.current += 1);
    controllerRef.current?.abort();

    if (!issued.readDiagnostics && !issued.readAutoClose) {
      if (mountedRef.current && issued.requestKey === currentKeyRef.current) {
        setSnapshot({
          key: issued.requestKey,
          health: null,
          autoClose: null,
          busy: false,
        });
      }
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setSnapshot((previous) => ({
      key: issued.requestKey,
      health: previous.key === issued.requestKey ? previous.health : null,
      autoClose: previous.key === issued.requestKey ? previous.autoClose : null,
      busy: true,
    }));

    const readOrNull = async <T,>(factory: () => Promise<T>): Promise<T | null> => {
      try {
        return await factory();
      } catch (nextError) {
        if (controller.signal.aborted) throw nextError;
        return null;
      }
    };

    try {
      const [health, autoClose] = await Promise.all([
        issued.readDiagnostics
          ? readOrNull(() => api.diagnosticsHealth(issued.windowHours, controller.signal))
          : Promise.resolve(null),
        issued.readAutoClose
          ? readOrNull(() => api.autoCloseHealth(issued.windowHours, controller.signal))
          : Promise.resolve(null),
      ]);

      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestId !== requestIdRef.current ||
        issued.requestKey !== currentKeyRef.current
      ) {
        return;
      }

      setSnapshot({
        key: issued.requestKey,
        health: health?.window_hours === issued.windowHours ? health : null,
        autoClose: autoClose?.window_hours === issued.windowHours ? autoClose : null,
        busy: false,
      });
    } catch {
      // A superseded request is expected to reject on abort. Other endpoint failures
      // are already converted independently to null by `readOrNull`.
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    void run();
    return () => {
      controllerRef.current?.abort();
    };
  }, [requestKey, run]);

  const current = snapshot.key === requestKey;
  return {
    health: current ? snapshot.health : null,
    autoClose: current ? snapshot.autoClose : null,
    busy: current ? snapshot.busy : true,
    reload: run,
  };
}
