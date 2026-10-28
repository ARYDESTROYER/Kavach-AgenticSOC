/**
 * Chat assistant settings section (chat revamp SPEC §4.2): the curated editor for
 * `Preferences.chat_agent`.
 *
 * Compact groups on the shared single-card surface, the limits mode first (Round 12
 * SPEC D1): Question limits (Unlimited — the default: a question runs until it answers
 * or the analyst presses Stop, guarded only by the engine's loop guards — or Bounded,
 * which shows the per-question knobs, the rarely-touched ones behind "More limits"),
 * Spending (the optional chat daily limit, SPEC D5), Answers (one "Typed-out answers"
 * control: Off, Allowed (off by default) or Allowed (on by default), mapped onto
 * `allow_text_streaming` and `default_stream_mode`; the animated logo), Suggestions
 * (Round 13 SPEC-chat T31: `dynamic_starters`, questions computed from live data at no
 * AI cost), Timeouts and capacity
 * (the knobs that apply in both modes) and which indicators chat may send to enrichment
 * providers. The section is the ONE editor for this block: `advanced-schema.tsx` lists
 * `chat_agent` in `CURATED_SECTIONS`, so every knob of the block must be reachable here
 * (that is why the disclosures exist rather than leaving the long tail to All settings).
 * The bounded-only knobs are reachable by switching to Bounded; their stored values are
 * kept either way, so switching back and forth is lossless.
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
 * construction, and these only bound spend, time and third-party egress. Every chat
 * model call is metered in the cost ledger whatever the mode (#6).
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import type { ChatAgentConfig, ChatLimitsMode } from '@/lib/types';
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
  max_parallel: 12,
  tool_timeout_s: 45,
  model_step_timeout_s: 900,
  turn_timeout_s: 90,
  turn_token_ceiling: 60_000,
  final_reserve_tokens: 12_000,
  observation_chars: 6_000,
  final_max_tokens: 4_000,
  max_concurrent_turns_per_user: 12,
  max_concurrent_turns_global: 48,
  max_indicator_lookups: 3,
  max_indicator_lookups_per_conversation: 10,
  default_stream_mode: 'steps',
  allow_text_streaming: true,
  internal_domains: [],
  allow_email_lookup: false,
  animated_brand: true,
  limits_mode: 'unlimited',
  chat_daily_cap_usd: null,
  dynamic_starters: true,
});

/**
 * The knobs that are caps only in `bounded` mode (backend `ChatAgentConfig` docstring,
 * SPEC D1). The rest — lookups at once, the lookup and model-call timeouts, how many
 * questions run at once, indicator lookups — apply in both modes.
 */
export const BOUNDED_ONLY_KNOBS: readonly ChatAgentNumericKey[] = [
  'max_model_calls',
  'max_tool_calls',
  'turn_token_ceiling',
  'final_reserve_tokens',
  'turn_timeout_s',
  'final_max_tokens',
  'observation_chars',
];

/** The editor's first value for the chat daily limit when it is switched on. */
export const CHAT_CAP_STARTING_USD = 5;
/** Typed amounts keep cents; the +/- buttons move by whole dollars. */
export const CHAT_CAP_STEP_USD = 0.01;
export const CHAT_CAP_STEPPER_USD = 1;

/**
 * What the "Limit per day" field stores: a positive amount, else `null` (off). 0 is the
 * backend's "no limit" (`_repair_chat_cap`), never a one-cent limit that would block
 * almost every chat model call.
 */
export function chatCapFromField(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `config._repair_chat_cap`: a positive finite number, else `null` (off). The editor
 * shows what the server will store.
 */
export function repairChatCap(raw: unknown): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const value = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** `limits_mode` as the backend reads it: anything but `bounded` is unlimited. */
export function limitsMode(cfg: Pick<ChatAgentConfig, 'limits_mode'> | null | undefined): ChatLimitsMode {
  return cfg?.limits_mode === 'bounded' ? 'bounded' : 'unlimited';
}

/** The numeric knobs of the block. */
export type ChatAgentNumericKey = {
  [K in keyof ChatAgentConfig]-?: ChatAgentConfig[K] extends number ? K : never;
}[keyof ChatAgentConfig];

/** Inclusive `[min, max]` per numeric knob: the backend `Field(ge=…, le=…)` ranges. */
export const CHAT_AGENT_BOUNDS: Readonly<Record<ChatAgentNumericKey, readonly [number, number]>> = {
  max_model_calls: [1, 12],
  max_tool_calls: [1, 40],
  max_parallel: [1, 24],
  tool_timeout_s: [1, 120],
  model_step_timeout_s: [5, 1_800],
  turn_timeout_s: [10, 600],
  turn_token_ceiling: [4_000, 1_000_000],
  final_reserve_tokens: [1_000, 200_000],
  observation_chars: [1_500, 60_000],
  final_max_tokens: [256, 32_000],
  max_concurrent_turns_per_user: [1, 24],
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
 * cross-field repair `ChatAgentConfig._coherent` applies on save: the final-answer
 * reserve must leave room for lookups inside the ceiling. Lookups at once is never
 * rewritten here: in Bounded mode one batch is limited by the per-question lookup budget
 * at run time ({@link effectiveParallel}, the backend's `effective_parallel`), so a
 * Bounded → Unlimited round trip keeps the operator's value.
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
  cfg.limits_mode = limitsMode(cfg);
  cfg.chat_daily_cap_usd = repairChatCap(cfg.chat_daily_cap_usd);
  // `config._repair`: only an explicit off turns live-data suggestions off (default on).
  cfg.dynamic_starters = cfg.dynamic_starters !== false;
  return cfg;
}

/** The one "Typed-out answers" control (SPEC-chat T31) over two stored fields. */
export type TypedAnswers = 'off' | 'allowed_off' | 'allowed_on';

/** What viewers get: Off when not allowed, else the org default. */
export function typedAnswers(cfg: Pick<ChatAgentConfig, 'allow_text_streaming' | 'default_stream_mode'>): TypedAnswers {
  if (!cfg.allow_text_streaming) return 'off';
  return cfg.default_stream_mode === 'text' ? 'allowed_on' : 'allowed_off';
}

/** The stored pair for a choice (no new config field). */
export function typedAnswersPatch(choice: TypedAnswers): Pick<ChatAgentConfig, 'allow_text_streaming' | 'default_stream_mode'> {
  if (choice === 'off') return { allow_text_streaming: false, default_stream_mode: 'steps' };
  return { allow_text_streaming: true, default_stream_mode: choice === 'allowed_on' ? 'text' : 'steps' };
}

/** The suggestions switch (T31), worded as the backend field's description. */
export const DYNAMIC_STARTERS_LABEL = 'Suggest questions from live data';
export const DYNAMIC_STARTERS_HELP =
  'New chats open with questions about your queue, SLA and sources, computed from data each viewer can read. No AI cost.';

/**
 * Lookups that really run side by side in one step (backend
 * `ChatAgentConfig.effective_parallel`): the stored value, and in Bounded mode never more
 * than Lookups per question. Display only, never written back as such: a value the
 * operator types or steps to is stored as entered.
 */
export function effectiveParallel(cfg: Pick<ChatAgentConfig, 'limits_mode' | 'max_parallel' | 'max_tool_calls'>): number {
  return cfg.limits_mode === 'bounded' ? Math.max(1, Math.min(cfg.max_parallel, cfg.max_tool_calls)) : cfg.max_parallel;
}

/**
 * The `defaultValue` of the Lookups at once field: the value its Reset stores, and the
 * value the field compares with to decide whether to offer Reset.
 *
 * Reset always stores the shipped default, never the value Bounded mode shows for it, so
 * a switch back to Unlimited shows the default again (SPEC D1, switching modes is
 * lossless). In Bounded mode the field shows the value that applies
 * ({@link effectiveParallel}, at most Lookups per question). When that is already what
 * the default would apply (12 lookups at once against the default budget of 10 both run
 * 10), Reset is not offered, so the value shown is returned. Typed and stepped values
 * never pass through here: they are stored as entered, and Unlimited then shows them.
 */
export function parallelFieldDefault(cfg: Pick<ChatAgentConfig, 'limits_mode' | 'max_parallel' | 'max_tool_calls'>): number {
  const shipped = CHAT_AGENT_DEFAULTS.max_parallel;
  const applied = effectiveParallel(cfg);
  return applied === effectiveParallel({ ...cfg, max_parallel: shipped }) ? applied : shipped;
}

/* -------------------------------------------------------------- rendering --- */

const TYPED_OPTIONS: { value: TypedAnswers; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'allowed_off', label: 'Allowed (off by default)' },
  { value: 'allowed_on', label: 'Allowed (on by default)' },
];

/** What each typed-out answers choice means, under the control. */
export const TYPED_ANSWERS_HELP: Readonly<Record<TypedAnswers, string>> = {
  off: 'Answers arrive whole. The composer switch is disabled and says why.',
  allowed_off: 'Answers arrive whole until a viewer turns on "Type out answers" in the composer options.',
  allowed_on: 'Answers appear word by word until a viewer turns it off in the composer options.',
};

const LIMITS_OPTIONS: { value: ChatLimitsMode; label: string }[] = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: 'bounded', label: 'Bounded' },
];

/** What each limits mode means, shown under the switch (SPEC D1, D2). */
export const LIMITS_MODE_HELP: Readonly<Record<ChatLimitsMode, string>> = {
  unlimited:
    'Chat keeps working until it has answered or someone presses Stop, and answers are never cut short. ' +
    'Loop guards still apply: the same lookup never runs twice, a question that stops making progress is ' +
    'asked to answer, a model call that goes silent is retried once, and a very long investigation wraps ' +
    'up with what it found.',
  bounded:
    'Each question stops looking things up at the limits below, answers from what it found and says so.',
};

/** The spending limit's help (SPEC D5). */
export const CHAT_CAP_HELP =
  'Off by default: the daily AI budget covers automatic investigations and never pauses chat. With a ' +
  'limit, chat stops starting model calls once its spending since 00:00 UTC reaches the amount, and the ' +
  'answer says so. Every chat call is still recorded in the cost ledger.';

interface LimitSpec {
  key: ChatAgentNumericKey;
  label: string;
  description: string;
  unit?: string;
  step?: number;
}

/** The bounded-mode limits operators actually tune. */
const MAIN_LIMITS: readonly LimitSpec[] = [
  { key: 'max_model_calls', label: 'Model calls', description: 'Including the final answer.' },
  { key: 'max_tool_calls', label: 'Lookups', description: 'Log searches, case counts, metrics and other reads.' },
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

/** The bounded-mode long tail, behind "More limits". */
const MORE_LIMITS: readonly LimitSpec[] = [
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
];

/** Knobs that apply in both modes, behind "Timeouts and capacity". */
const CAPACITY_LIMITS: readonly LimitSpec[] = [
  { key: 'max_parallel', label: 'Lookups at once', description: 'Run side by side in one step.' },
  { key: 'tool_timeout_s', label: 'Lookup timeout', description: 'Per lookup.', unit: 's' },
  {
    key: 'model_step_timeout_s',
    label: 'Model call timeout',
    description: 'How long one model call may go silent before it is retried once.',
    unit: 's',
  },
  { key: 'max_concurrent_turns_per_user', label: 'Questions at once per user', description: 'Workspace and case chat together.' },
  { key: 'max_concurrent_turns_global', label: 'Questions at once in total', description: 'For this backend process.' },
];

const LOOKUP_LIMITS: readonly LimitSpec[] = [
  { key: 'max_indicator_lookups', label: 'Per question', description: '0 turns indicator lookups off for chat.' },
  { key: 'max_indicator_lookups_per_conversation', label: 'Per conversation', description: 'Counts every lookup sent.' },
];

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground">
          <ChevronDown
            className={cn('h-4 w-4 transition-transform motion-reduce:transition-none', open && 'rotate-180')}
            aria-hidden
          />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ChatAgentSection({ prefs, update }: SecProps) {
  const cfg = React.useMemo(() => coherentChatAgent(prefs.chat_agent), [prefs.chat_agent]);
  const mode = limitsMode(cfg);
  const bounded = mode === 'bounded';
  const capOn = cfg.chat_daily_cap_usd !== null && cfg.chat_daily_cap_usd !== undefined;
  const limitsHelpId = React.useId();
  const typedHelpId = React.useId();
  const typed = typedAnswers(cfg);
  const capSwitchRef = React.useRef<HTMLDivElement>(null);

  const set = (patch: Partial<ChatAgentConfig>) => update({ chat_agent: coherentChatAgent({ ...cfg, ...patch }) });

  const focusCapSwitch = () => {
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    capSwitchRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  };

  // A field's upper bound also respects the other knob it must stay coherent with, so
  // the stepper never offers a value the server would repair. Lookups at once is
  // bounded by Lookups per question only where that is a cap (Bounded mode), and there
  // the field shows the value that really applies; the stored value is kept as is, so
  // switching back to Unlimited shows it again (display only, never saved). A value the
  // operator types or steps to is stored as entered; its Reset stores the shipped default
  // (`parallelFieldDefault`).
  const maxFor = (key: ChatAgentNumericKey): number => {
    const [, hi] = CHAT_AGENT_BOUNDS[key];
    if (key === 'max_parallel' && bounded) return Math.min(hi, cfg.max_tool_calls);
    if (key === 'final_reserve_tokens') return Math.min(hi, cfg.turn_token_ceiling - 1);
    return hi;
  };
  const shown = (key: ChatAgentNumericKey): number => (key === 'max_parallel' ? effectiveParallel(cfg) : cfg[key]);
  const defaultFor = (key: ChatAgentNumericKey): number =>
    key === 'max_parallel' ? parallelFieldDefault(cfg) : CHAT_AGENT_DEFAULTS[key];

  const describe = (spec: LimitSpec): string =>
    spec.key === 'max_parallel' && bounded
      ? `${spec.description} At most Lookups per question (${cfg.max_tool_calls}) in Bounded mode.`
      : spec.description;

  const numberField = (spec: LimitSpec) => (
    <NumberField
      key={spec.key}
      label={spec.label}
      description={describe(spec)}
      value={shown(spec.key)}
      min={CHAT_AGENT_BOUNDS[spec.key][0]}
      max={maxFor(spec.key)}
      step={spec.step}
      unit={spec.unit}
      defaultValue={defaultFor(spec.key)}
      onChange={(value) => set({ [spec.key]: value } as Partial<ChatAgentConfig>)}
    />
  );

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Chat assistant"
        sub="How the read-only assistant answers in Workspace and Case Manager chat: whether a question has limits, what chat may spend, typed-out answers, suggested questions, and which indicators it may send to enrichment providers."
      />

      <section className="space-y-4">
        <SubHeader title="Question limits" />
        <div className="space-y-1.5">
          {/* SegmentedControl names itself with aria-label only, so the visible label is
              plain text beside it (a <label> would point at no control). */}
          <p className="text-sm font-medium leading-none text-foreground">Limits per question</p>
          <SegmentedControl
            aria-label="Limits per question"
            aria-describedby={limitsHelpId}
            size="sm"
            options={LIMITS_OPTIONS}
            value={mode}
            onValueChange={(value) => set({ limits_mode: value })}
          />
          {/* Linked to the switch and polite: a mode change reads what the mode means. */}
          <p
            id={limitsHelpId}
            aria-live="polite"
            className="max-w-3xl text-xs leading-relaxed text-muted-foreground"
            data-testid="chat-limits-help"
          >
            {LIMITS_MODE_HELP[mode]}
          </p>
        </div>
        {bounded ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="chat-bounded-limits">
              {MAIN_LIMITS.map(numberField)}
            </div>
            <Disclosure label="More limits">
              <div className="grid gap-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">{MORE_LIMITS.map(numberField)}</div>
            </Disclosure>
          </>
        ) : null}
      </section>

      <section className="space-y-4 border-t border-border/70 pt-4">
        <SubHeader title="Spending" />
        <div ref={capSwitchRef}>
          <SwitchPref
            label="Daily chat spending limit"
            help={CHAT_CAP_HELP}
            checked={capOn}
            onChange={(on) => set({ chat_daily_cap_usd: on ? (cfg.chat_daily_cap_usd ?? CHAT_CAP_STARTING_USD) : null })}
          />
        </div>
        {capOn ? (
          <NumberField
            label="Limit per day"
            description="US dollars of chat spending per day (UTC). 0 turns the limit off."
            value={cfg.chat_daily_cap_usd ?? CHAT_CAP_STARTING_USD}
            min={0}
            step={CHAT_CAP_STEP_USD}
            stepperStep={CHAT_CAP_STEPPER_USD}
            // A cleared field goes back to the starting amount, never to one cent.
            defaultValue={CHAT_CAP_STARTING_USD}
            unit="USD"
            onChange={(value) => {
              const cap = chatCapFromField(value);
              set({ chat_daily_cap_usd: cap });
              // 0 switched the limit off and this field goes away: if focus went with it,
              // put it on the switch (never away from a control the operator moved to).
              if (cap === null) window.setTimeout(focusCapSwitch, 0);
            }}
            className="max-w-xs"
          />
        ) : null}
      </section>

      <section className="space-y-4 border-t border-border/70 pt-4">
        <SubHeader title="Answers" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium leading-none text-foreground">Typed-out answers</p>
          <SegmentedControl
            aria-label="Typed-out answers"
            aria-describedby={typedHelpId}
            size="sm"
            orientation="both"
            className="h-auto flex-wrap"
            options={TYPED_OPTIONS}
            value={typed}
            onValueChange={(value) => set(typedAnswersPatch(value))}
          />
          <p id={typedHelpId} aria-live="polite" className="text-xs text-muted-foreground" data-testid="typed-answers-help">
            {TYPED_ANSWERS_HELP[typed]}
          </p>
        </div>
        <SwitchPref
          label="Animate the logo while chat works"
          help="A thin ring turns around the logo while an answer is being written. A custom logo itself never moves; the Chat item keeps its own indicator either way."
          checked={cfg.animated_brand !== false}
          onChange={(value) => set({ animated_brand: value })}
        />
      </section>

      <section className="space-y-4 border-t border-border/70 pt-4">
        <SubHeader title="Suggestions" />
        <SwitchPref
          label={DYNAMIC_STARTERS_LABEL}
          help={DYNAMIC_STARTERS_HELP}
          checked={cfg.dynamic_starters !== false}
          onChange={(value) => set({ dynamic_starters: value })}
        />
      </section>

      <section className="space-y-3 border-t border-border/70 pt-4">
        <SubHeader title="Timeouts and capacity" />
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
          These apply in both modes: how many lookups run side by side, how long a lookup or a silent model call
          may take, and how many questions can run at the same time.
        </p>
        <Disclosure label="Show timeouts and capacity">
          <div className="grid gap-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">{CAPACITY_LIMITS.map(numberField)}</div>
        </Disclosure>
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
