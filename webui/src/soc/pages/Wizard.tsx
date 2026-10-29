/**
 * First-run setup workspace.
 *
 * The wizard deliberately keeps account bootstrap in Login (POST /setup/account),
 * then guides an authenticated operator through four optional-but-honest stages:
 * workspace mode, data sources, AI runtime, and a readiness review. Secrets remain
 * write-only; all source/provider values render as plain text.
 */
import * as React from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Database,
  FlaskConical,
  KeyRound,
  Loader2,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';

import type {
  ConfiguredStatus,
  ConnectorManifest,
  SecretsUpdate,
  SetupStatus,
  SourceInstance,
} from '@/lib/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { properName } from '@/lib/proper-names';

import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Progress } from '@/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';

import { LoadingState } from '@/design-system';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SecretField } from '@/soc/components/SecretField';
import type { SourceEditorProps } from '@/soc/components/SourceEditor';
import { useAuth } from '@/soc/auth';
import { isDemoActive, useDemo } from '@/soc/demo';
import { headingOf, useReturnFocus } from '@/soc/hooks/useReturnFocus';

/**
 * The source editor is a large manifest-driven form that only an operator who opens it on
 * the Data sources stage ever sees, so it loads on demand instead of shipping with first
 * paint (this page is eager). The import fails soft: the wizard renders outside every
 * error boundary, so a chunk that cannot load (a redeploy, a proxy, going offline) shows
 * a reload notice instead of throwing.
 */
const SourceEditor = React.lazy(
  (): Promise<{ default: React.ComponentType<SourceEditorProps> }> =>
    import('@/soc/components/SourceEditor').then(
      (module) => ({ default: module.SourceEditor }),
      () => ({ default: SourceEditorUnavailable }),
    ),
);

function SourceEditorUnavailable(_props: SourceEditorProps) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <span>The source editor could not load. Reload the page to try again.</span>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

type StepState = 'current' | 'ready' | 'attention' | 'available';
type PendingNavigation = { kind: 'step'; step: number } | { kind: 'exit' };

const STEPS: Array<{
  key: string;
  title: string;
  shortTitle: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    key: 'workspace',
    title: 'Choose your workspace',
    shortTitle: 'Workspace',
    description: 'Start with isolated sample activity or connect a live environment.',
    icon: ShieldCheck,
  },
  {
    key: 'sources',
    title: 'Connect data sources',
    shortTitle: 'Data sources',
    description: 'Add the systems that produce the security telemetry you want to triage.',
    icon: Database,
  },
  {
    key: 'runtime',
    title: 'Connect an AI runtime',
    shortTitle: 'AI runtime',
    description: 'Add a provider credential for live investigations, or use the mock runtime.',
    icon: KeyRound,
  },
  {
    key: 'review',
    title: 'Review and launch',
    shortTitle: 'Review & launch',
    description: 'See what is ready now and what can be configured after launch.',
    icon: ClipboardCheck,
  },
];

export interface WizardProps {
  onComplete: () => void;
  /** Present only when Settings re-runs the wizard. */
  onExit?: () => void;
}

export default function Wizard({ onComplete, onExit }: WizardProps) {
  const [step, setStep] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [bootError, setBootError] = React.useState<unknown>(null);
  const [finishError, setFinishError] = React.useState<unknown>(null);
  const [finishing, setFinishing] = React.useState(false);
  const [status, setStatus] = React.useState<SetupStatus | null>(null);
  const [connectors, setConnectors] = React.useState<ConnectorManifest[]>([]);
  const [sources, setSources] = React.useState<SourceInstance[]>([]);
  const [sourceEditorOpen, setSourceEditorOpen] = React.useState(false);
  const [pendingNavigation, setPendingNavigation] = React.useState<PendingNavigation | null>(
    null,
  );
  const [confirmLiveMode, setConfirmLiveMode] = React.useState(false);
  const [transitionBusy, setTransitionBusy] = React.useState(false);

  const [keyValues, setKeyValues] = React.useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = React.useState(false);
  const [keysError, setKeysError] = React.useState<unknown>(null);
  const [keysNotice, setKeysNotice] = React.useState<string | null>(null);

  const { authEnabled, hasPermission } = useAuth();
  const { status: demoStatus, refresh: refreshDemo } = useDemo();
  const canManageDemo = !authEnabled || hasPermission('demo', 'manage');

  const [demoMode, setDemoMode] = React.useState(false);
  const [demoBusy, setDemoBusy] = React.useState(false);
  const [demoError, setDemoError] = React.useState<unknown>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // The two confirmations open from state, not from a Radix trigger, so each hands focus
  // back to what opened it when cancelled (SPEC §3.3, WCAG 2.4.3). A confirmed step change
  // hands it to the new stage's heading instead.
  const navigationOpener = useReturnFocus();
  const liveModeOpener = useReturnFocus();
  const modeGroupRef = React.useRef<HTMLDivElement>(null);
  const completedRef = React.useRef(false);
  const transitionLockRef = React.useRef(false);

  const runTransition = React.useCallback(async (work: () => Promise<void>) => {
    if (transitionLockRef.current) return;
    transitionLockRef.current = true;
    setTransitionBusy(true);
    try {
      await work();
    } finally {
      transitionLockRef.current = false;
      setTransitionBusy(false);
    }
  }, []);

  React.useEffect(() => {
    setDemoMode(isDemoActive(demoStatus));
  }, [demoStatus]);

  const loadWizard = React.useCallback(async () => {
    setLoading(true);
    setBootError(null);
    try {
      const [nextStatus, nextConnectors, nextSources] = await Promise.all([
        api.setupStatus(),
        api.listConnectors(),
        api.listSources(),
      ]);
      setStatus(nextStatus);
      setConnectors(nextConnectors.connectors);
      setSources(nextSources.sources);
    } catch (error) {
      setBootError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadWizard();
  }, [loadWizard]);

  React.useLayoutEffect(() => {
    if (loading || bootError) return;
    headingRef.current?.focus();
  }, [step, loading, bootError]);

  const refreshStatus = React.useCallback(async () => {
    const [nextStatus, nextSources] = await Promise.all([
      api.setupStatus(),
      api.listSources(),
    ]);
    setStatus(nextStatus);
    setSources(nextSources.sources);
  }, []);

  const applyDemoMode = React.useCallback(
    (nextOn: boolean) => {
      if (!canManageDemo || nextOn === demoMode) return;
      void runTransition(async () => {
        setDemoBusy(true);
        setDemoError(null);
        setDemoMode(nextOn);
        try {
          const nextStatus = nextOn
            ? await api.demo.enable({ mode: 'live' })
            : await api.demo.disable();
          setDemoMode(isDemoActive(nextStatus));
        } catch (error) {
          setDemoMode(!nextOn);
          setDemoError(error);
        } finally {
          setDemoBusy(false);
          void refreshDemo();
        }
      });
    },
    [canManageDemo, demoMode, refreshDemo, runTransition],
  );

  const requestDemoMode = React.useCallback(
    (nextOn: boolean) => {
      if (transitionLockRef.current || nextOn === demoMode) return;
      if (!nextOn && demoMode) {
        if (canManageDemo) {
          // Resolved when the confirmation closes: the checked mode (Synthetic demo after
          // Cancel), or the stage heading while the switch keeps the choices disabled.
          liveModeOpener.remember(() => {
            const checked = modeGroupRef.current?.querySelector<HTMLElement>(
              '[role="radio"][aria-checked="true"]:not(:disabled)',
            );
            return checked ?? headingRef.current;
          });
          setConfirmLiveMode(true);
        }
        return;
      }
      applyDemoMode(nextOn);
    },
    [applyDemoMode, canManageDemo, demoMode, liveModeOpener],
  );

  const configured: ConfiguredStatus = status?.configured ?? {};
  const hasProvider =
    Boolean(configured.anthropic_api_key) || Boolean(configured.openai_api_key);
  const hasKeyDraft = Object.values(keyValues).some((value) => value.trim());
  const enabledSources = sources.filter((source) => source.enabled !== false);

  const saveKeys = React.useCallback(async (): Promise<boolean> => {
    const body: SecretsUpdate = {};
    for (const field of KEY_FIELDS) {
      const value = (keyValues[field.key] || '').trim();
      if (value) (body as Record<string, string>)[field.key] = value;
    }
    if (!Object.keys(body).length) return true;

    setSavingKeys(true);
    setKeysError(null);
    setKeysNotice(null);
    try {
      const result = await api.updateSecrets(body);
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              configured: { ...previous.configured, ...result.configured },
            }
          : { setup_complete: false, configured: result.configured },
      );
      setKeyValues({});
      try {
        await refreshStatus();
      } catch {
        setKeysNotice('Keys were saved. Live status will refresh after setup.');
      }
      // Preserve the authoritative write response even if the subsequent status read
      // is eventually consistent and briefly returns the old boolean.
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              configured: { ...previous.configured, ...result.configured },
            }
          : { setup_complete: false, configured: result.configured },
      );
      return true;
    } catch (error) {
      setKeysError(error);
      return false;
    } finally {
      setSavingKeys(false);
    }
  }, [keyValues, refreshStatus]);

  const finishOnce = React.useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
  }, [onComplete]);

  const finish = React.useCallback(() => {
    void runTransition(async () => {
      setFinishing(true);
      setFinishError(null);
      try {
        if (hasKeyDraft) {
          const saved = await saveKeys();
          if (!saved) {
            setStep(2);
            return;
          }
        }

        try {
          await api.completeSetup();
          finishOnce();
        } catch (error) {
          // A dropped response after a successful write must not strand the operator on
          // setup. Reconcile once against the authoritative public status endpoint.
          try {
            const reconciled = await api.setupStatus();
            if (reconciled.setup_complete) {
              setStatus(reconciled);
              finishOnce();
              return;
            }
          } catch {
            // Preserve the original completion error below.
          }
          setFinishError(error);
        }
      } finally {
        setFinishing(false);
      }
    });
  }, [finishOnce, hasKeyDraft, runTransition, saveKeys]);

  const performNavigation = React.useCallback(
    (navigation: PendingNavigation) => {
      void runTransition(async () => {
        if (step === 2 && hasKeyDraft) {
          const saved = await saveKeys();
          if (!saved) return;
        }
        if (navigation.kind === 'exit') onExit?.();
        else setStep(navigation.step);
      });
    },
    [hasKeyDraft, onExit, runTransition, saveKeys, step],
  );

  const requestNavigation = React.useCallback(
    (navigation: PendingNavigation, opener?: HTMLElement) => {
      if (transitionLockRef.current) return;
      if (navigation.kind === 'step' && navigation.step === step) return;
      if (step === 1 && sourceEditorOpen) {
        navigationOpener.remember(opener);
        setPendingNavigation(navigation);
        return;
      }
      performNavigation(navigation);
    },
    [navigationOpener, performNavigation, sourceEditorOpen, step],
  );

  const stepStates: StepState[] = [
    step === 0 ? 'current' : 'ready',
    step === 1 ? 'current' : enabledSources.length > 0 || demoMode ? 'ready' : 'attention',
    step === 2 ? 'current' : hasProvider || demoMode ? 'ready' : 'attention',
    step === 3 ? 'current' : 'available',
  ];
  const isLast = step === STEPS.length - 1;
  const continueLabel =
    (step === 1 && !enabledSources.length && !demoMode) ||
    (step === 2 && !hasProvider && !hasKeyDraft)
      ? 'Skip for now'
      : 'Continue';

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-foreground">
      <a
        href="#setup-main"
        className="sr-only z-50 rounded-md bg-canvas px-3 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:ring-2 focus:ring-ring"
      >
        Skip to setup content
      </a>

      <header className="shrink-0 border-b border-border bg-canvas">
        <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Agentic SOC</div>
              <div className="text-xs text-muted-foreground">Setup workspace</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="hidden sm:inline-flex">
              Step {step + 1} of {STEPS.length}
            </Badge>
            {onExit ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => requestNavigation({ kind: 'exit' }, event.currentTarget)}
                disabled={loading || transitionBusy}
              >
                <X className="h-4 w-4" aria-hidden /> Close
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[264px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-border bg-surface/30 lg:flex lg:flex-col">
          <div className="shrink-0 px-6 pb-5 pt-8">
            <p className="text-sm font-semibold text-foreground">Get operational</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Configure the minimum needed to explore or begin live triage. Every choice
              can be changed later.
            </p>
          </div>
          <nav
            aria-label="Setup progress"
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
          >
            <ol className="space-y-1">
              {STEPS.map((item, index) => (
                <li key={item.key}>
                  <StepButton
                    item={item}
                    index={index}
                    state={stepStates[index]}
                    onClick={(event) => requestNavigation({ kind: 'step', step: index }, event.currentTarget)}
                    disabled={loading || transitionBusy}
                  />
                </li>
              ))}
            </ol>
          </nav>
          <div className="shrink-0 border-t border-border px-6 py-5">
            <div className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                Provider and connector secrets are write-only. The Console only reports
                whether each secret is configured.
              </span>
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="shrink-0 border-b border-border px-4 py-4 lg:hidden">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold text-foreground">{STEPS[step].shortTitle}</span>
              <span className="text-muted-foreground">
                {step + 1} / {STEPS.length}
              </span>
            </div>
            <Progress
              value={((step + 1) / STEPS.length) * 100}
              className="h-1"
              aria-label="Setup progress"
              aria-valuetext={`Step ${step + 1} of ${STEPS.length}`}
            />
          </div>

          <main id="setup-main" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
            <div className="mx-auto w-full max-w-[960px] px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
              <div className="sr-only" aria-live="polite">
                {STEPS[step].shortTitle}, step {step + 1} of {STEPS.length}
              </div>

              {loading ? (
                <LoadingState
                  label="Loading setup"
                  description="Preparing workspace choices and deployment readiness."
                  layout="panel"
                  shape="panel"
                />
              ) : bootError ? (
                <LoadError
                  error={bootError}
                  title="Couldn’t load setup"
                  fallback="The Console could not load setup state."
                  onRetry={() => void loadWizard()}
                />
              ) : (
                <>
                  {step === 0 ? (
                    <WorkspaceStep
                      headingRef={headingRef}
                      modeGroupRef={modeGroupRef}
                      demoMode={demoMode}
                      demoBusy={demoBusy}
                      demoError={demoError}
                      canManageDemo={canManageDemo}
                      transitionBusy={transitionBusy}
                      onDemoMode={requestDemoMode}
                    />
                  ) : null}
                  {step === 1 ? (
                    <SourcesStep
                      headingRef={headingRef}
                      connectors={connectors}
                      sources={sources}
                      demoMode={demoMode}
                      onChanged={refreshStatus}
                      onEditorStateChange={setSourceEditorOpen}
                      onRetryCatalog={loadWizard}
                    />
                  ) : null}
                  {step === 2 ? (
                    <KeysStep
                      headingRef={headingRef}
                      configured={configured}
                      values={keyValues}
                      demoMode={demoMode}
                      error={keysError}
                      notice={keysNotice}
                      onChange={(key, value) =>
                        setKeyValues((previous) => ({ ...previous, [key]: value }))
                      }
                    />
                  ) : null}
                  {step === 3 ? (
                    <ReviewStep
                      headingRef={headingRef}
                      demoMode={demoMode}
                      sources={sources}
                      configured={configured}
                    />
                  ) : null}

                  {finishError ? (
                    <LoadError
                      error={finishError}
                      title="Couldn’t complete setup"
                      fallback="Setup was not marked complete. Review the connection and try again."
                      className="mt-8"
                      onRetry={finish}
                      retryLabel="Try again"
                    />
                  ) : null}
                </>
              )}
            </div>
          </main>

          <footer className="shrink-0 border-t border-border bg-canvas">
            <div className="mx-auto flex w-full max-w-[960px] items-center justify-between gap-3 px-5 py-4 sm:px-8 lg:px-12">
              <Button
                variant="ghost"
                onClick={(event) =>
                  requestNavigation({ kind: 'step', step: Math.max(0, step - 1) }, event.currentTarget)
                }
                disabled={loading || step === 0 || transitionBusy}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden /> Back
              </Button>
              {isLast ? (
                <Button size="lg" onClick={finish} disabled={loading || transitionBusy}>
                  {finishing ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Rocket className="h-4 w-4" aria-hidden />
                  )}
                  {onExit ? 'Apply changes' : 'Launch Agentic SOC'}
                </Button>
              ) : (
                <Button
                  onClick={(event) => requestNavigation({ kind: 'step', step: step + 1 }, event.currentTarget)}
                  disabled={loading || transitionBusy}
                >
                  {savingKeys ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {continueLabel} <ArrowRight className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </div>
          </footer>
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(pendingNavigation)}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
        title="Discard this source draft?"
        description="The source editor has unsaved work. Leaving this step will discard the draft."
        confirmLabel="Discard and continue"
        destructive
        returnFocusRef={navigationOpener.ref}
        onConfirm={() => {
          // The dialog still traps focus while the next stage renders, so its heading
          // takes focus when the dialog has closed.
          navigationOpener.remember(() => headingRef.current);
          const navigation = pendingNavigation;
          setPendingNavigation(null);
          setSourceEditorOpen(false);
          if (navigation) performNavigation(navigation);
        }}
      />

      <ConfirmDialog
        open={confirmLiveMode}
        onOpenChange={setConfirmLiveMode}
        returnFocusRef={liveModeOpener.ref}
        title="Switch to a live workspace?"
        description="This disables Synthetic demo and removes its isolated sample activity. Configured live sources and provider credentials remain in place."
        confirmLabel="Disable demo and switch"
        destructive
        onConfirm={() => {
          setConfirmLiveMode(false);
          applyDemoMode(false);
        }}
      />
    </div>
  );
}

function StepButton({
  item,
  index,
  state,
  onClick,
  disabled,
}: {
  item: (typeof STEPS)[number];
  index: number;
  state: StepState;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={state === 'current' ? 'step' : undefined}
      aria-label={`Step ${index + 1}: ${item.shortTitle}`}
      className={cn(
        'group flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-wait disabled:opacity-60',
        state === 'current' ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/70',
      )}
    >
      <span
        className={cn(
          'mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
          state === 'current'
            ? 'border-primary/30 bg-primary/10 text-primary'
            : state === 'ready'
              ? 'border-success/25 bg-success/10 text-success-text'
              : state === 'attention'
                ? 'border-warning/25 bg-warning/10 text-warning-text'
                : 'border-border bg-canvas text-muted-foreground',
        )}
      >
        {state === 'ready' ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : state === 'attention' ? (
          <TriangleAlert className="h-4 w-4" aria-hidden />
        ) : state === 'available' ? (
          <Circle className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Icon className="h-4 w-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{item.shortTitle}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {item.description}
        </span>
      </span>
    </button>
  );
}

/**
 * The stage heading. The stage's name is already the current item of the progress rail
 * (and of the progress strip on a phone), so there is no overline above the title. The
 * title takes focus after every transition: `outline-0` rather than `outline-none`,
 * whose transparent outline forced-colours mode paints as a box.
 */
function StepHeading({
  headingRef,
  title,
  description,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-8 border-b border-border pb-6">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-2xl font-semibold text-foreground outline-0 sm:text-3xl"
      >
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
        {description}
      </p>
    </div>
  );
}

function WorkspaceStep({
  headingRef,
  modeGroupRef,
  demoMode,
  demoBusy,
  demoError,
  canManageDemo,
  transitionBusy,
  onDemoMode,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  /** The workspace-mode radio group: the live-mode confirmation returns focus into it. */
  modeGroupRef: React.RefObject<HTMLDivElement>;
  demoMode: boolean;
  demoBusy: boolean;
  demoError: unknown;
  canManageDemo: boolean;
  transitionBusy: boolean;
  onDemoMode: (next: boolean) => void;
}) {
  const mode = demoMode ? 'demo' : 'live';
  return (
    <div>
      <StepHeading
        headingRef={headingRef}
        title="How do you want to start?"
        description="Use realistic synthetic activity to learn the Console, or connect your own systems for live triage. Demo data stays isolated and can be removed at any time."
      />

      <RadioGroup
        ref={modeGroupRef}
        value={mode}
        onValueChange={(value) => void onDemoMode(value === 'demo')}
        disabled={transitionBusy}
        className="divide-y divide-border border-y border-border"
        aria-label="Workspace mode"
      >
        <WorkspaceChoice
          id="workspace-live"
          value="live"
          title="Live environment"
          description="Connect your security data and an AI provider. The Console starts processing once setup is launched."
          icon={ServerCog}
          selected={!demoMode}
          busy={demoBusy}
          disabled={demoMode && !canManageDemo}
          detail={
            demoMode && !canManageDemo
              ? 'Requires demo management permission to disable the active demo'
              : 'Best for production and integration testing'
          }
        />
        <WorkspaceChoice
          id="workspace-demo"
          value="demo"
          title="Synthetic demo"
          description="Seed sample cases, metrics, and activity without touching a real SIEM or incurring model cost."
          icon={FlaskConical}
          selected={demoMode}
          busy={demoBusy}
          disabled={!canManageDemo}
          detail={canManageDemo ? 'Isolated · reversible · $0 inference' : 'Requires demo management permission'}
        />
      </RadioGroup>

      <div className="mt-6 flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
        <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          {demoMode
            ? 'Demo is active. The next two steps are optional; sample activity and the mock AI runtime are already available.'
            : 'Live mode is selected. Add at least one source and provider key for full triage capability.'}
        </p>
      </div>

      {demoError ? (
        <LoadError
          error={demoError}
          title="Couldn’t switch workspace mode"
          fallback="The workspace mode was not changed."
          className="mt-6"
        />
      ) : null}
    </div>
  );
}

function WorkspaceChoice({
  id,
  value,
  title,
  description,
  detail,
  icon: Icon,
  selected,
  busy,
  disabled,
}: {
  id: string;
  value: string;
  title: string;
  description: string;
  detail: string;
  icon: LucideIcon;
  selected: boolean;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <Label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-4 px-1 py-6 text-left transition-colors sm:px-3',
        'hover:bg-muted/30',
        selected && 'bg-primary/[0.04]',
        disabled && 'cursor-not-allowed opacity-55',
      )}
    >
      <span
        className={cn(
          'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border',
          selected
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'border-border bg-surface text-muted-foreground',
        )}
      >
        {busy && selected ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : (
          <Icon className="h-5 w-5" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold text-foreground">{title}</span>
          {selected ? <Badge variant="info">Selected</Badge> : null}
        </span>
        <span className="mt-1 block max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </span>
        <span className="mt-2 block text-xs font-medium text-muted-foreground">{detail}</span>
      </span>
      <RadioGroupItem id={id} value={value} disabled={disabled || busy} className="mt-1" />
    </Label>
  );
}

function SourcesStep({
  headingRef,
  connectors,
  sources,
  demoMode,
  onChanged,
  onEditorStateChange,
  onRetryCatalog,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  connectors: ConnectorManifest[];
  sources: SourceInstance[];
  demoMode: boolean;
  onChanged: () => Promise<void> | void;
  onEditorStateChange: (open: boolean) => void;
  onRetryCatalog: () => Promise<void> | void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<SourceInstance | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<SourceInstance | null>(null);
  // The remove confirmation opens from a row's Remove button. Cancel hands focus back to
  // it; a removal takes the row away once the list reloads, and focus then moves to the
  // next row's Remove, else the list heading (SPEC §3.3).
  const removeOpener = useReturnFocus();
  const listRef = React.useRef<HTMLDivElement>(null);
  const editorOpen = adding || Boolean(editing);
  const enabledSourceCount = sources.filter((source) => source.enabled !== false).length;
  const disabledSourceCount = sources.length - enabledSourceCount;

  React.useEffect(() => {
    onEditorStateChange(editorOpen);
    return () => onEditorStateChange(false);
  }, [editorOpen, onEditorStateChange]);

  const reload = async () => {
    setAdding(false);
    setEditing(null);
    setError(null);
    try {
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    }
  };

  const setPrimary = async (source: SourceInstance) => {
    setBusyId(source.id);
    setError(null);
    try {
      await api.upsertSource({
        id: source.id,
        source_type: source.source_type,
        display_name: source.display_name,
        enabled: source.enabled,
        is_primary: true,
        ingest_mode: source.ingest_mode ?? null,
        config: (source.config as Record<string, unknown>) || {},
      });
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (source: SourceInstance) => {
    setBusyId(source.id);
    setError(null);
    try {
      await api.deleteSource(source.id);
      removeOpener.expectRemoval();
      await onChanged();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <StepHeading
        headingRef={headingRef}
        title="Connect the systems you already use"
        description="Add pull, push, queue, or object-store sources. Agentic SOC normalizes each record into the same internal event model before correlation and triage."
      />

      {demoMode ? (
        <p className="mb-6 flex items-start gap-2 text-sm text-muted-foreground">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Optional in Demo mode: sample activity is already seeded. Add a real source when
            you are ready to test an integration.
          </span>
        </p>
      ) : null}

      {error ? (
        <LoadError
          error={error}
          title="Couldn’t update data sources"
          fallback="The source change was not applied."
          className="mb-6"
          onRetry={() => void onChanged()}
        />
      ) : null}

      {!connectors.length ? (
        <EmptyState
          icon={Database}
          title="Connector catalog unavailable"
          description="No connector definitions were returned. Retry the catalog before adding a source."
          action={
            <Button variant="outline" onClick={() => void onRetryCatalog()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Retry catalog
            </Button>
          }
        />
      ) : null}

      {connectors.length && !editorOpen ? (
        <div ref={listRef}>
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {sources.length
                  ? `${enabledSourceCount} enabled${
                      disabledSourceCount ? ` · ${disabledSourceCount} disabled` : ''
                    }`
                  : 'No sources configured'}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Secrets stay write-only and are never returned to this screen.
              </p>
            </div>
            <Button onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Add source
            </Button>
          </div>

          {sources.length ? (
            <div className="divide-y divide-border border-y border-border">
              {sources.map((source) => {
                const manifest = connectors.find(
                  (connector) => connector.source_type === source.source_type,
                );
                const secretCount = source.configured_secrets?.length || 0;
                const canBePrimary =
                  source.ingest_mode === 'pull' ||
                  source.ingest_mode?.startsWith('pull_') ||
                  manifest?.ingest_modes?.includes('pull');
                return (
                  <div
                    key={source.id}
                    className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center"
                  >
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
                      <Database className="h-5 w-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-semibold text-foreground">
                          {source.display_name || manifest?.display_name || properName(source.source_type)}
                        </span>
                        {source.is_primary ? <Badge variant="info">Primary</Badge> : null}
                        {source.enabled === false ? <Badge variant="outline">Disabled</Badge> : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {properName(source.source_type)}
                        {source.ingest_mode ? ` · ${properName(source.ingest_mode)}` : ''}
                        {secretCount ? ` · ${secretCount} secret${secretCount === 1 ? '' : 's'} configured` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      {!source.is_primary && canBePrimary ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void setPrimary(source)}
                          disabled={busyId === source.id}
                        >
                          {busyId === source.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : (
                            <Star className="h-4 w-4" aria-hidden />
                          )}
                          Make primary
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => setEditing(source)}>
                        <Pencil className="h-4 w-4" aria-hidden /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        // Neutral at rest; red only on hover, focus and in the confirm dialog.
                        className="hover:text-critical-text focus-visible:text-critical-text aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                        onClick={(event) => {
                          if (busyId === source.id) return;
                          removeOpener.remember(event.currentTarget, {
                            peers: () => listRef.current?.querySelectorAll('[data-wizard-source-remove]') ?? [],
                            empty: () => headingOf(listRef.current),
                          });
                          setPendingDelete(source);
                        }}
                        // Busy, not disabled, while the removal runs: the confirmation hands
                        // focus back here, which a disabled button would refuse.
                        aria-disabled={busyId === source.id || undefined}
                        data-wizard-source-remove=""
                      >
                        <Trash2 className="h-4 w-4" aria-hidden /> Remove
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="border-y border-border py-10">
              <EmptyState
                compact
                icon={Database}
                title="Start with one data source"
                description="Choose from the connector catalog, test the draft, then save it. You can add more later."
                action={
                  <Button onClick={() => setAdding(true)}>
                    <Plus className="h-4 w-4" aria-hidden /> Add your first source
                  </Button>
                }
              />
            </div>
          )}
        </div>
      ) : null}

      {connectors.length && editorOpen ? (
        <section className="border-t border-border pt-6" aria-label="Source editor">
          <div className="mb-6">
            <p className="text-sm text-muted-foreground">{editing ? 'Edit source' : 'New source'}</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">
              {editing
                ? editing.display_name || properName(editing.source_type)
                : 'Choose and configure a connector'}
            </h2>
          </div>
          <React.Suspense fallback={<LoadingState label="Loading the source editor" layout="panel" />}>
            <SourceEditor
              connectors={connectors}
              existing={editing || undefined}
              defaultPrimary={sources.length === 0}
              onSaved={() => void reload()}
              onCancel={() => void reload()}
            />
          </React.Suspense>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Remove this source?"
        returnFocusRef={removeOpener.ref}
        description={
          pendingDelete
            ? `“${pendingDelete.display_name || properName(pendingDelete.source_type)}” and its configuration${
                pendingDelete.configured_secrets?.length ? ', including stored secrets,' : ''
              } will be deleted. This can’t be undone.`
            : ''
        }
        destructive
        confirmLabel="Remove source"
        onConfirm={() => {
          const source = pendingDelete;
          setPendingDelete(null);
          if (source) void remove(source);
        }}
      />
    </div>
  );
}

interface KeyField {
  key: keyof SecretsUpdate;
  label: string;
  description: string;
}

const KEY_FIELDS: KeyField[] = [
  {
    key: 'openai_api_key',
    label: 'OpenAI API key',
    description: 'Default runtime for GPT-5.6 Luna completion roles and vector embeddings.',
  },
  {
    key: 'anthropic_api_key',
    label: 'Anthropic API key',
    description: 'Optional alternate runtime for Claude models.',
  },
  {
    key: 'embedding_api_key',
    label: 'Embedding API key',
    description: 'Optional. Leave blank to reuse the OpenAI key for knowledge retrieval.',
  },
];

function KeysStep({
  headingRef,
  configured,
  values,
  demoMode,
  error,
  notice,
  onChange,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  configured: ConfiguredStatus;
  values: Record<string, string>;
  demoMode: boolean;
  error: unknown;
  notice: string | null;
  onChange: (key: string, value: string) => void;
}) {
  const anyConfigured =
    Boolean(configured.anthropic_api_key) || Boolean(configured.openai_api_key);
  return (
    <div>
      <StepHeading
        headingRef={headingRef}
        title="Connect the models that investigate cases"
        description="Add at least one provider for live reasoning. Model selection, budgets, and routing stay configurable in Settings after launch."
      />

      <Alert variant={demoMode ? 'info' : anyConfigured ? 'success' : 'warning'} className="mb-6">
        {demoMode ? (
          <FlaskConical className="h-4 w-4" aria-hidden />
        ) : anyConfigured ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden />
        ) : (
          <TriangleAlert className="h-4 w-4" aria-hidden />
        )}
        <AlertTitle>
          {demoMode
            ? 'Mock runtime available'
            : anyConfigured
              ? 'Live provider configured'
              : 'A live provider is recommended'}
        </AlertTitle>
        <AlertDescription>
          {demoMode
            ? 'Demo investigations run against the deterministic mock runtime at no inference cost. A live key is optional.'
            : anyConfigured
              ? 'New credentials replace only the provider you update; existing secret values are never shown.'
              : 'You can continue without a key, but live investigations will use the limited mock runtime until a provider is added.'}
        </AlertDescription>
      </Alert>

      <div className="divide-y divide-border border-y border-border">
        {KEY_FIELDS.map((field) => (
          <div key={field.key} className="py-5">
            <SecretField
              label={field.label}
              description={`${field.description} Stored write-only; the Console reports only whether it is configured.`}
              configured={Boolean(configured[field.key])}
              value={values[field.key] || ''}
              onChange={(value) => onChange(field.key, value)}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <p>Typed keys save automatically whenever you leave this step.</p>
      </div>

      {notice ? (
        <Alert variant="success" className="mt-6">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          <AlertTitle>Keys saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <LoadError
          error={error}
          title="Couldn’t save provider keys"
          fallback="The keys were not saved. Check the connection and try again."
          className="mt-6"
        />
      ) : null}
    </div>
  );
}

type ReadinessState = 'ready' | 'warning' | 'optional';

function ReviewStep({
  headingRef,
  demoMode,
  sources,
  configured,
}: {
  headingRef: React.RefObject<HTMLHeadingElement>;
  demoMode: boolean;
  sources: SourceInstance[];
  configured: ConfiguredStatus;
}) {
  const hasProvider =
    Boolean(configured.anthropic_api_key) || Boolean(configured.openai_api_key);
  const enabledSources = sources.filter((source) => source.enabled !== false);
  const disabledSourceCount = sources.length - enabledSources.length;
  const primary = enabledSources.find((source) => source.is_primary);
  const fullLive = !demoMode && enabledSources.length > 0 && hasProvider;
  const heading = demoMode
    ? 'Demo workspace is ready'
    : fullLive
      ? 'Ready for live triage'
      : 'Ready with limited capabilities';
  const description = demoMode
    ? 'Sample cases and the mock runtime are available as soon as you launch.'
    : fullLive
      ? 'Your source and AI runtime are connected. Polling and triage can begin after launch.'
      : 'You can launch now, but the Console will remain partially configured until the warnings below are resolved.';

  return (
    <div>
      <StepHeading
        headingRef={headingRef}
        title={heading}
        description={description}
      />

      <div className="divide-y divide-border border-y border-border">
        <ReadinessRow
          icon={demoMode ? FlaskConical : ServerCog}
          title="Workspace"
          state="ready"
          detail={demoMode ? 'Synthetic demo · isolated sample activity' : 'Live environment'}
        />
        <ReadinessRow
          icon={Database}
          title="Data sources"
          state={enabledSources.length ? 'ready' : demoMode ? 'optional' : 'warning'}
          detail={
            enabledSources.length
              ? `${enabledSources.length} enabled source${
                  enabledSources.length === 1 ? '' : 's'
                }${disabledSourceCount ? ` · ${disabledSourceCount} disabled` : ''}${
                  primary ? ` · primary: ${primary.display_name || primary.source_type}` : ''
                }`
              : demoMode
                ? `${
                    disabledSourceCount
                      ? `No enabled sources · ${disabledSourceCount} configured but disabled · `
                      : ''
                  }Optional in demo · sample activity is already seeded`
                : disabledSourceCount
                  ? `No enabled sources · ${disabledSourceCount} configured but disabled`
                  : 'No source configured · live telemetry will not be ingested'
          }
        />
        <ReadinessRow
          icon={KeyRound}
          title="AI runtime"
          state={hasProvider ? 'ready' : demoMode ? 'optional' : 'warning'}
          detail={
            hasProvider
              ? `Configured: ${[
                  configured.anthropic_api_key ? 'Anthropic' : null,
                  configured.openai_api_key ? 'OpenAI' : null,
                ]
                  .filter(Boolean)
                  .join(', ')}`
              : demoMode
                ? 'Deterministic mock runtime · no inference cost'
                : 'No provider configured · mock runtime only'
          }
        />
        <div className="flex items-start gap-4 py-6">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Automation posture</h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Enabled by default. Tunes investigation routing and groups related cases.
                  Close and escalation decisions remain deterministic. Setup does not change
                  an existing automation policy.
                </p>
              </div>
              <Badge variant="success">
                <Check className="h-3 w-3" aria-hidden /> On by default
              </Badge>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-start gap-3 rounded-md border border-border bg-surface/50 px-4 py-4">
        <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div>
          <p className="text-sm font-medium text-foreground">Launch is non-destructive</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Re-run this setup from Settings at any time. Existing sources and credentials
            remain in place unless you explicitly change or remove them.
          </p>
        </div>
      </div>
    </div>
  );
}

function ReadinessRow({
  icon: Icon,
  title,
  detail,
  state,
}: {
  icon: LucideIcon;
  title: string;
  detail: React.ReactNode;
  state: ReadinessState;
}) {
  const status =
    state === 'ready' ? 'Ready' : state === 'warning' ? 'Needs attention' : 'Optional';
  return (
    <div className="flex items-start gap-4 py-5">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <Badge
            variant={state === 'ready' ? 'success' : state === 'warning' ? 'warning' : 'outline'}
          >
            {state === 'ready' ? (
              <Check className="h-3 w-3" aria-hidden />
            ) : state === 'warning' ? (
              <TriangleAlert className="h-3 w-3" aria-hidden />
            ) : (
              <Circle className="h-2.5 w-2.5" aria-hidden />
            )}
            {status}
          </Badge>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
