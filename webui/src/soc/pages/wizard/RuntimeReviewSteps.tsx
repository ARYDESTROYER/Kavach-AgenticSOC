/**
 * The setup wizard's AI runtime and review stages (Round 15, SPEC §3.1 and D2.3).
 *
 * A lazy chunk: first paint is the workspace stage, so these two stages, their provider
 * table, key fields and readiness rows load on demand (Wizard.tsx `LaterStage`, one lazy
 * component for both, `RuntimeReviewStage` below). The wizard prefetches the chunk into
 * the HTTP cache once the browser is idle, so reaching either stage normally shows no
 * wait. All state stays in the wizard: these stages only render what it passes and report
 * key edits back.
 */
import * as React from 'react';
import {
  Check,
  CheckCircle2,
  Circle,
  Database,
  FlaskConical,
  KeyRound,
  LockKeyhole,
  Rocket,
  ServerCog,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import type { ConfiguredStatus, SecretsUpdate, SourceInstance } from '@/lib/types';

import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';

import { LoadError } from '@/soc/components/LoadError';
import { SecretField } from '@/soc/components/SecretField';

import { StepHeading } from './StepHeading';

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

/**
 * Provider family token (`llm/readiness.py`), its label and, when it is not
 * `<token>_api_key`, its configured-boolean key.
 */
const PROVIDERS = [
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['openai_compatible', 'OpenAI-compatible endpoint', 'litellm_api_key'],
  ['azure', 'Azure OpenAI', 'azure_openai_api_key'],
  ['bedrock', 'Amazon Bedrock', 'aws_access_key_id'],
  ['vertex', 'Google Vertex AI'],
];
const providerLabel = (token?: string) => (PROVIDERS.find((p) => p[0] === token) || [])[1];
const DEFAULT_MODELS = 'the default models';
const configuredProviders = (configured: ConfiguredStatus) =>
  PROVIDERS.filter((p) => configured[p[2] || p[0] + '_api_key']).map((p) => p[1]);

export interface KeysStepProps {
  headingRef: React.RefObject<HTMLHeadingElement>;
  configured: ConfiguredStatus;
  /** The default investigation models can be called (`ai_runtime_ready`). */
  ready: boolean;
  /** Their provider family, when known. */
  provider?: string;
  values: Record<string, string>;
  demoMode: boolean;
  error: unknown;
  notice: string | null;
  onChange: (key: string, value: string) => void;
}

export function KeysStep({
  headingRef,
  configured,
  ready,
  provider,
  values,
  demoMode,
  error,
  notice,
  onChange,
}: KeysStepProps) {
  // A key is set but the default models cannot use it (an Anthropic key for OpenAI models).
  const keyPresent = configuredProviders(configured).length > 0;
  const label = providerLabel(provider);
  return (
    <div>
      <StepHeading
        headingRef={headingRef}
        title="Connect the models that investigate cases"
        description="Add at least one provider for live reasoning. Model selection, budgets, and routing stay configurable in Settings after launch."
      />

      <Alert variant={demoMode ? 'info' : ready ? 'success' : 'warning'} className="mb-6">
        {demoMode ? (
          <FlaskConical className="h-4 w-4" aria-hidden />
        ) : ready ? (
          <CheckCircle2 className="h-4 w-4" aria-hidden />
        ) : (
          <TriangleAlert className="h-4 w-4" aria-hidden />
        )}
        <AlertTitle>
          {demoMode
            ? 'Mock runtime available'
            : ready
              ? 'Live provider configured'
              : keyPresent
                ? 'Your key does not match the default models'
                : 'No usable AI provider yet'}
        </AlertTitle>
        <AlertDescription>
          {demoMode
            ? 'Demo investigations run against the deterministic mock runtime at no inference cost. A live key is optional.'
            : ready
              ? 'New credentials replace only the provider you update; existing secret values are never shown.'
              : keyPresent
                ? `${label ? `The default investigation models use ${label}. ` : ''}Add a key for ${label || DEFAULT_MODELS}, or choose other models in Settings → Models after launch.`
                : 'You can continue without a key. Until you add one, the AI agent investigates nothing: new cases wait for a person as Needs human review.'}
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

export interface ReviewStepProps {
  headingRef: React.RefObject<HTMLHeadingElement>;
  demoMode: boolean;
  sources: SourceInstance[];
  configured: ConfiguredStatus;
  /** The default investigation models can be called (`ai_runtime_ready`). */
  ready: boolean;
  provider?: string;
}

export function ReviewStep({
  headingRef,
  demoMode,
  sources,
  configured,
  ready: hasProvider,
  provider,
}: ReviewStepProps) {
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
              ? `Configured: ${
                  configuredProviders(configured).join(', ') || providerLabel(provider) || DEFAULT_MODELS
                }`
              : demoMode
                ? 'Deterministic mock runtime · no inference cost'
                : 'No usable provider · cases wait for a person'
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

/** The stage the wizard shows, with that stage's props. */
export type RuntimeReviewStageProps =
  | ({ stage: 'runtime' } & KeysStepProps)
  | ({ stage: 'review' } & ReviewStepProps);

/**
 * Both stages behind one component, so the wizard's one lazy component resolves once:
 * whichever of the two stages is reached second renders at once, with no loading state.
 */
export function RuntimeReviewStage(props: RuntimeReviewStageProps) {
  return props.stage === 'runtime' ? <KeysStep {...props} /> : <ReviewStep {...props} />;
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
