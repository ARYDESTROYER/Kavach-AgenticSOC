/**
 * Chat assistant settings section (chat revamp SPEC §4.2): the curated editor for
 * `Preferences.chat_agent`.
 *
 * Three compact groups on the shared single-card surface: how answers arrive (the
 * org's default live mode and whether "Type out answers" is allowed at all), how much
 * one question may use (model calls, lookups, tokens, time; the rarely-touched knobs sit
 * behind "More limits"), and which indicators chat may send to enrichment providers.
 * The section is the ONE editor for this block: `advanced-schema.tsx` lists
 * `chat_agent` in `CURATED_SECTIONS`, so every knob of the block must be reachable here
 * (that is why "More limits" exists rather than leaving the long tail to All settings).
 *
 * Validation mirrors the backend instead of inventing rules: the numeric ranges are
 * `ChatAgentConfig`'s `ge`/`le` (pinned by a test that reads `config.py`), the domain
 * suffix grammar is `_DOMAIN_SUFFIX_RE`, and {@link coherentChatAgent} applies the same
 * cross-field repair as `ChatAgentConfig._coherent`, so what the operator sees after
 * Save is what they set. The server still clamps and repairs everything (a stored value
 * can never fail validation); the UI only keeps the operator from typing a value the
 * server would silently change.
 *
 * None of these knobs can widen what chat may DO: the assistant is read-only by
 * construction, and these only bound spend, time and third-party egress.
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import type { ChatAgentConfig, ChatStreamMode } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { NumberField } from '@/soc/components/NumberField';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { TagInput } from '@/soc/components/TagInput';

import { SectionTitle, SubHeader, SwitchPref, type SecProps } from './primitives';

/* -------------------------------------------------------------- contract --- */

/** `ChatAgentConfig` defaults (backend `config.py`); used when a backend omits the block. */
export const CHAT_AGENT_DEFAULTS: Readonly<ChatAgentConfig> = Object.freeze({
  max_model_calls: 5,
  max_tool_calls: 10,
  max_parallel: 4,
  tool_timeout_s: 15,
  model_step_timeout_s: 30,
  turn_timeout_s: 90,
  turn_token_ceiling: 60_000,
  final_reserve_tokens: 12_000,
  observation_chars: 6_000,
  final_max_tokens: 4_000,
  max_concurrent_turns_per_user: 2,
  max_concurrent_turns_global: 8,
  max_indicator_lookups: 3,
  max_indicator_lookups_per_conversation: 10,
  default_stream_mode: 'steps',
  allow_text_streaming: true,
  internal_domains: [],
  allow_email_lookup: false,
});

/** The numeric knobs of the block. */
export type ChatAgentNumericKey = {
  [K in keyof ChatAgentConfig]: ChatAgentConfig[K] extends number ? K : never;
}[keyof ChatAgentConfig];

/** Inclusive `[min, max]` per numeric knob: the backend `Field(ge=…, le=…)` ranges. */
export const CHAT_AGENT_BOUNDS: Readonly<Record<ChatAgentNumericKey, readonly [number, number]>> = {
  max_model_calls: [1, 12],
  max_tool_calls: [1, 40],
  max_parallel: [1, 8],
  tool_timeout_s: [1, 120],
  model_step_timeout_s: [5, 300],
  turn_timeout_s: [10, 600],
  turn_token_ceiling: [4_000, 1_000_000],
  final_reserve_tokens: [1_000, 200_000],
  observation_chars: [1_500, 60_000],
  final_max_tokens: [256, 32_000],
  max_concurrent_turns_per_user: [1, 10],
  max_concurrent_turns_global: [1, 100],
  max_indicator_lookups: [0, 10],
  max_indicator_lookups_per_conversation: [0, 50],
};

/** `ChatAgentConfig._MAX_INTERNAL_DOMAINS`. */
export const MAX_INTERNAL_DOMAINS = 100;

/** `config._DOMAIN_SUFFIX_RE`: a plausible DNS suffix, ≤ 253 chars, labels ≤ 63. */
const DOMAIN_SUFFIX_RE =
  /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/;

/**
 * One internal-domain entry as the backend stores it (`ChatAgentConfig.normalise_domains`):
 * lower-cased, a leading `*.` and any leading or trailing dots removed. Null when the
 * result is not a plausible DNS suffix, so the field refuses it instead of the server
 * silently dropping it on save.
 */
export function normaliseInternalDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  while (value.startsWith('*.')) value = value.slice(2);
  value = value.replace(/^\.+|\.+$/g, '');
  return value && DOMAIN_SUFFIX_RE.test(value) ? value : null;
}

/**
 * The block as the editor shows it: stored values over the defaults, then the same
 * cross-field repair `ChatAgentConfig._coherent` applies on save — the final-answer
 * reserve must leave room for lookups inside the ceiling, and one batch can never be
 * larger than the per-question lookup budget.
 */
export function coherentChatAgent(stored: Partial<ChatAgentConfig> | null | undefined): ChatAgentConfig {
  const cfg: ChatAgentConfig = {
    ...CHAT_AGENT_DEFAULTS,
    ...(stored ?? {}),
    internal_domains: [...(stored?.internal_domains ?? CHAT_AGENT_DEFAULTS.internal_domains)],
  };
  if (cfg.final_reserve_tokens >= cfg.turn_token_ceiling) {
    cfg.final_reserve_tokens = Math.max(1_000, Math.floor(cfg.turn_token_ceiling / 5));
  }
  if (cfg.max_parallel > cfg.max_tool_calls) cfg.max_parallel = cfg.max_tool_calls;
  return cfg;
}

/* -------------------------------------------------------------- rendering --- */

const MODE_OPTIONS: { value: ChatStreamMode; label: string }[] = [
  { value: 'steps', label: 'Live steps' },
  { value: 'text', label: 'Type out answers' },
];

interface LimitSpec {
  key: ChatAgentNumericKey;
  label: string;
  description: string;
  unit?: string;
  step?: number;
}

/** The limits operators actually tune. */
const MAIN_LIMITS: readonly LimitSpec[] = [
  { key: 'max_model_calls', label: 'Model calls', description: 'Including the final answer.' },
  { key: 'max_tool_calls', label: 'Lookups', description: 'Log searches, case counts, metrics and other reads.' },
  { key: 'max_parallel', label: 'Lookups at once', description: 'Run side by side in one step.' },
  {
    key: 'turn_token_ceiling',
    label: 'Token ceiling',
    description: 'Input plus output across all model calls.',
    unit: 'tokens',
    step: 1_000,
  },
  {
    key: 'turn_timeout_s',
    label: 'Time limit',
    description: 'No new lookup starts after this.',
    unit: 's',
  },
];

/** The long tail, behind "More limits". */
const MORE_LIMITS: readonly LimitSpec[] = [
  { key: 'tool_timeout_s', label: 'Lookup timeout', description: 'Per lookup.', unit: 's' },
  { key: 'model_step_timeout_s', label: 'Model call timeout', description: 'Per model call.', unit: 's' },
  {
    key: 'final_reserve_tokens',
    label: 'Answer reserve',
    description: 'Kept inside the ceiling for writing the answer.',
    unit: 'tokens',
    step: 1_000,
  },
  { key: 'final_max_tokens', label: 'Answer length', description: 'Output tokens for the answer.', unit: 'tokens' },
  {
    key: 'observation_chars',
    label: 'Results per step',
    description: 'Aggregated results only; raw logs never reach the model.',
    unit: 'chars',
    step: 500,
  },
  { key: 'max_concurrent_turns_per_user', label: 'Questions at once per user', description: 'Workspace and case chat together.' },
  { key: 'max_concurrent_turns_global', label: 'Questions at once in total', description: 'For this backend process.' },
];

const LOOKUP_LIMITS: readonly LimitSpec[] = [
  { key: 'max_indicator_lookups', label: 'Per question', description: '0 turns indicator lookups off for chat.' },
  { key: 'max_indicator_lookups_per_conversation', label: 'Per conversation', description: 'Counts every lookup sent.' },
];

export function ChatAgentSection({ prefs, update }: SecProps) {
  const cfg = React.useMemo(() => coherentChatAgent(prefs.chat_agent), [prefs.chat_agent]);
  const [moreOpen, setMoreOpen] = React.useState(false);

  const set = (patch: Partial<ChatAgentConfig>) => update({ chat_agent: coherentChatAgent({ ...cfg, ...patch }) });

  // A field's upper bound also respects the other knob it must stay coherent with, so
  // the stepper never offers a value the server would repair.
  const maxFor = (key: ChatAgentNumericKey): number => {
    const [, hi] = CHAT_AGENT_BOUNDS[key];
    if (key === 'max_parallel') return Math.min(hi, cfg.max_tool_calls);
    if (key === 'final_reserve_tokens') return Math.min(hi, cfg.turn_token_ceiling - 1);
    return hi;
  };

  const numberField = (spec: LimitSpec) => (
    <NumberField
      key={spec.key}
      label={spec.label}
      description={spec.description}
      value={cfg[spec.key]}
      min={CHAT_AGENT_BOUNDS[spec.key][0]}
      max={maxFor(spec.key)}
      step={spec.step}
      unit={spec.unit}
      defaultValue={CHAT_AGENT_DEFAULTS[spec.key]}
      onChange={(value) => set({ [spec.key]: value } as Partial<ChatAgentConfig>)}
    />
  );

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Chat assistant"
        sub="How the read-only assistant answers in Workspace and Case Manager chat: the live mode, how much one question may use, and which indicators it may send to enrichment providers."
      />

      <section className="space-y-4">
        <SubHeader title="Answers" />
        <div className="space-y-1.5">
          {/* SegmentedControl names itself with aria-label only, so the visible label is
              plain text beside it (a <label> would point at no control). */}
          <p className="text-sm font-medium leading-none text-foreground">Default live mode</p>
          <SegmentedControl
            aria-label="Default live mode"
            size="sm"
            options={MODE_OPTIONS.map((o) => ({ ...o, disabled: o.value === 'text' && !cfg.allow_text_streaming }))}
            value={cfg.allow_text_streaming ? cfg.default_stream_mode : 'steps'}
            onValueChange={(value) => set({ default_stream_mode: value })}
          />
          <p className="text-xs text-muted-foreground">
            {cfg.allow_text_streaming
              ? 'Applies until a viewer picks their own mode in the composer options.'
              : 'Answers arrive whole while typed-out answers are not allowed.'}
          </p>
        </div>
        <SwitchPref
          label="Allow typed-out answers"
          help="Lets answers appear word by word. When off, the composer switch is disabled and says why."
          checked={cfg.allow_text_streaming}
          onChange={(value) => set({ allow_text_streaming: value })}
        />
      </section>

      <section className="space-y-4 border-t border-border/70 pt-4">
        <SubHeader title="Per-question limits" />
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          A question that reaches a limit stops looking things up, answers from what it found and says so.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{MAIN_LIMITS.map(numberField)}</div>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground">
              <ChevronDown
                className={cn('h-4 w-4 transition-transform motion-reduce:transition-none', moreOpen && 'rotate-180')}
                aria-hidden
              />
              More limits
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid gap-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">{MORE_LIMITS.map(numberField)}</div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section className="space-y-4 border-t border-border/70 pt-4">
        <SubHeader title="Indicator lookups" />
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Chat sends an indicator to your enrichment providers only when it appears in the analyst&apos;s own
          words or in this question&apos;s results. Private, reserved and loopback addresses and single-label
          hosts are never sent.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{LOOKUP_LIMITS.map(numberField)}</div>
        <TagInput
          label="Internal domains"
          description="Domain suffixes that are never sent, with their subdomains. Press Enter or comma to add."
          placeholder="corp.example"
          value={cfg.internal_domains}
          max={MAX_INTERNAL_DOMAINS}
          validate={(tag) =>
            normaliseInternalDomain(tag) ? null : 'Enter a domain suffix such as corp.example.'
          }
          onChange={(next) => {
            const out: string[] = [];
            for (const tag of next) {
              const value = normaliseInternalDomain(tag);
              if (value && !out.includes(value)) out.push(value);
            }
            set({ internal_domains: out.slice(0, MAX_INTERNAL_DOMAINS) });
          }}
          className="max-w-2xl"
        />
        <SwitchPref
          label="Allow e-mail lookups"
          help="Off by default: e-mail addresses are personal data."
          checked={cfg.allow_email_lookup}
          onChange={(value) => set({ allow_email_lookup: value })}
        />
      </section>
    </div>
  );
}
