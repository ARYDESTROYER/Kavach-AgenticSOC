/**
 * Chat assistant settings section (chat revamp SPEC §4.2): the curated editor for
 * `Preferences.chat_agent`.
 *
 * Proves that the section
 *   - mirrors the backend contract (every numeric knob's default and `ge`/`le` range is
 *     read back from `ChatAgentConfig` in `backend/app/config.py`, so a backend change
 *     without a matching editor change fails here),
 *   - applies the same cross-field repair as `ChatAgentConfig._coherent`, so the saved
 *     value is the one the operator sees,
 *   - normalises internal domains exactly like `normalise_domains` and refuses one the
 *     server would silently drop,
 *   - edits through the shared `{prefs, update}` buffer with one `chat_agent` patch, and
 *   - keeps every knob reachable (the long tail sits behind "More limits" and "Show
 *     timeouts and capacity"), because the generic All settings view no longer shows
 *     this block, and
 *   - shows the Round 12 limits mode first (Unlimited by default, the per-question knobs
 *     only in Bounded) and the optional chat daily spending limit (SPEC D1, D5), and
 *   - Round 13 (SPEC-chat T31): one "Typed-out answers" control over
 *     `allow_text_streaming` + `default_stream_mode`, and the "Suggest questions from
 *     live data" switch (`dynamic_starters`, on by default), and
 *   - Round 14 (SPEC §4.2): the tripled Timeouts and capacity defaults and their wider
 *     ranges, with Bounded mode showing the Lookups at once that really applies (10), a
 *     Reset storing the shipped default (12) so switching back to Unlimited shows it, and
 *     every typed or stepped value stored as entered (SPEC D1).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatAgentConfig, Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import {
  BOUNDED_ONLY_KNOBS,
  CHAT_AGENT_BOUNDS,
  CHAT_AGENT_DEFAULTS,
  CHAT_CAP_STARTING_USD,
  ChatAgentSection,
  DYNAMIC_STARTERS_HELP,
  TYPED_ANSWERS_HELP,
  typedAnswers,
  typedAnswersPatch,
  chatCapFromField,
  LIMITS_MODE_HELP,
  MAX_INTERNAL_DOMAINS,
  coherentChatAgent,
  effectiveParallel,
  limitsMode,
  normaliseInternalDomain,
  parallelFieldDefault,
  repairChatCap,
} from '../chat-agent';

/** The shipped defaults in bounded mode (the per-question knobs on screen). */
const BOUNDED: ChatAgentConfig = { ...CHAT_AGENT_DEFAULTS, limits_mode: 'bounded' };

/**
 * The accessible name of NumberField's reset affordance. Exact and case-insensitive, so an
 * absence check can never pass only because the label's case changed.
 */
const RESET = { name: /^reset$/i };

/** The field group (label, reset, input, hint) of a labelled NumberField. */
function fieldRoot(label: string): HTMLElement {
  return screen.getByLabelText(label).closest('.space-y-1\\.5') as HTMLElement;
}

expect.extend(toHaveNoViolations);

function renderSection(chat_agent?: Partial<ChatAgentConfig>) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const prefs = (chat_agent ? { chat_agent } : {}) as Preferences;
  const utils = render(
    <TooltipProvider>
      <ChatAgentSection prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  /** The `chat_agent` block of the most recent patch. */
  const lastPatch = (): ChatAgentConfig => {
    expect(update).toHaveBeenCalled();
    const patch = update.mock.calls[update.mock.calls.length - 1][0];
    expect(Object.keys(patch)).toEqual(['chat_agent']);
    return patch.chat_agent as ChatAgentConfig;
  };
  return { update, lastPatch, ...utils };
}

function commitNumber(label: string, value: string) {
  const input = screen.getByLabelText(label);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

/* ------------------------------------------------------------ the contract -- */

describe('the editor mirrors backend ChatAgentConfig', () => {
  const source = readFileSync(path.resolve(process.cwd(), '..', 'backend', 'app', 'config.py'), 'utf8');
  const start = source.indexOf('class ChatAgentConfig(BaseModel):');
  const body = source.slice(start, source.indexOf('_MAX_INTERNAL_DOMAINS', start));
  const fields = new Map<string, { default: number; ge: number; le: number }>();
  for (const m of body.matchAll(/(\w+): int = Field\(\s*default=([\d_]+),\s*ge=([\d_]+),\s*le=([\d_]+)/g)) {
    const num = (raw: string) => Number(raw.replace(/_/g, ''));
    fields.set(m[1], { default: num(m[2]), ge: num(m[3]), le: num(m[4]) });
  }

  it('reads every numeric knob from config.py (the parser found the class)', () => {
    expect(start).toBeGreaterThan(0);
    expect([...fields.keys()].sort()).toEqual(Object.keys(CHAT_AGENT_BOUNDS).sort());
  });

  it('uses the backend default and inclusive range for every numeric knob', () => {
    for (const [name, spec] of fields) {
      const key = name as keyof typeof CHAT_AGENT_BOUNDS;
      expect(CHAT_AGENT_BOUNDS[key], name).toEqual([spec.ge, spec.le]);
      expect(CHAT_AGENT_DEFAULTS[key], name).toBe(spec.default);
    }
  });

  it('matches the non-numeric defaults and the internal-domain cap', () => {
    expect(body).toMatch(/default_stream_mode: Literal\["steps", "text"\] = Field\(\s*default="steps"/);
    expect(CHAT_AGENT_DEFAULTS.default_stream_mode).toBe('steps');
    expect(body).toMatch(/allow_text_streaming: bool = Field\(\s*default=True/);
    expect(CHAT_AGENT_DEFAULTS.allow_text_streaming).toBe(true);
    expect(body).toMatch(/allow_email_lookup: bool = Field\(\s*default=False/);
    expect(CHAT_AGENT_DEFAULTS.allow_email_lookup).toBe(false);
    expect(body).toMatch(/animated_brand: bool = Field\(\s*default=True/);
    expect(CHAT_AGENT_DEFAULTS.animated_brand).toBe(true);
    expect(body).toMatch(/dynamic_starters: bool = Field\(\s*default=True/);
    expect(CHAT_AGENT_DEFAULTS.dynamic_starters).toBe(true);
    expect(CHAT_AGENT_DEFAULTS.internal_domains).toEqual([]);
    expect(source.slice(start)).toMatch(new RegExp(`_MAX_INTERNAL_DOMAINS: ClassVar\\[int\\] = ${MAX_INTERNAL_DOMAINS}\\b`));
  });

  it('matches the Round 12 limits mode and chat daily limit (SPEC D1, D5)', () => {
    expect(body).toMatch(/limits_mode: Literal\["unlimited", "bounded"\] = Field\(\s*default="unlimited"/);
    expect(CHAT_AGENT_DEFAULTS.limits_mode).toBe('unlimited');
    expect(body).toMatch(/chat_daily_cap_usd: float \| None = Field\(\s*default=None, ge=0/);
    expect(CHAT_AGENT_DEFAULTS.chat_daily_cap_usd).toBeNull();
  });

  it('carries the tripled Timeouts and capacity defaults and ranges (Round 14 SPEC §4.2.1)', () => {
    expect(CHAT_AGENT_DEFAULTS.max_parallel).toBe(12);
    expect(CHAT_AGENT_DEFAULTS.tool_timeout_s).toBe(45);
    expect(CHAT_AGENT_DEFAULTS.model_step_timeout_s).toBe(900);
    expect(CHAT_AGENT_DEFAULTS.max_concurrent_turns_per_user).toBe(12);
    expect(CHAT_AGENT_DEFAULTS.max_concurrent_turns_global).toBe(48);
    expect(CHAT_AGENT_BOUNDS.max_parallel).toEqual([1, 24]);
    expect(CHAT_AGENT_BOUNDS.tool_timeout_s).toEqual([1, 120]);
    expect(CHAT_AGENT_BOUNDS.model_step_timeout_s).toEqual([5, 1_800]);
    expect(CHAT_AGENT_BOUNDS.max_concurrent_turns_per_user).toEqual([1, 24]);
    expect(CHAT_AGENT_BOUNDS.max_concurrent_turns_global).toEqual([1, 100]);
  });

  it('lists exactly the knobs the backend says apply only in bounded mode', () => {
    // The class docstring names them: "``unlimited`` (the default) ignores ``a``, ``b`` … as caps".
    const doc = body.slice(body.indexOf('ignores'), body.indexOf('as caps'));
    const named = [...doc.matchAll(/``(\w+)``/g)].map((m) => m[1]).filter((n) => n !== 'unlimited');
    expect(named.sort()).toEqual([...BOUNDED_ONLY_KNOBS].sort());
  });
});

describe('repairChatCap (the twin of config._repair_chat_cap)', () => {
  it('keeps a positive finite amount and turns anything else off', () => {
    expect(repairChatCap(12.5)).toBe(12.5);
    expect(repairChatCap('3')).toBe(3);
    for (const off of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, true, 'abc', '']) {
      expect(repairChatCap(off), String(off)).toBeNull();
    }
  });

  it('reads anything but bounded as unlimited, like ChatAgentConfig.unlimited', () => {
    expect(limitsMode({ limits_mode: 'bounded' })).toBe('bounded');
    expect(limitsMode({ limits_mode: 'unlimited' })).toBe('unlimited');
    expect(limitsMode({})).toBe('unlimited');
    expect(limitsMode(null)).toBe('unlimited');
  });
});

describe('coherentChatAgent (the twin of ChatAgentConfig._coherent)', () => {
  it('fills a missing block with the defaults', () => {
    expect(coherentChatAgent(undefined)).toEqual(CHAT_AGENT_DEFAULTS);
    expect(coherentChatAgent({ max_tool_calls: 20 }).max_tool_calls).toBe(20);
  });

  it('keeps the answer reserve inside the ceiling', () => {
    const cfg = coherentChatAgent({ turn_token_ceiling: 10_000, final_reserve_tokens: 12_000 });
    expect(cfg.final_reserve_tokens).toBe(2_000);
    // The floor matches the backend's max(1000, ceiling // 5).
    expect(coherentChatAgent({ turn_token_ceiling: 4_000, final_reserve_tokens: 4_000 }).final_reserve_tokens).toBe(1_000);
  });

  it('never rewrites Lookups at once: the bounded-mode limit applies at use (like effective_parallel)', () => {
    // Stored values are kept in both modes, so a mode round trip is lossless.
    expect(coherentChatAgent({ limits_mode: 'bounded', max_tool_calls: 2, max_parallel: 4 }).max_parallel).toBe(4);
    expect(coherentChatAgent({ limits_mode: 'unlimited', max_tool_calls: 2, max_parallel: 4 }).max_parallel).toBe(4);
    // Bounded: one batch never runs more than the per-question lookup budget.
    expect(effectiveParallel({ limits_mode: 'bounded', max_tool_calls: 2, max_parallel: 4 })).toBe(2);
    expect(effectiveParallel({ limits_mode: 'bounded', max_tool_calls: 6, max_parallel: 4 })).toBe(4);
    // Unlimited (D1): the lookup budget is not a cap, so it never limits parallelism.
    expect(effectiveParallel({ limits_mode: 'unlimited', max_tool_calls: 2, max_parallel: 4 })).toBe(4);
  });

  it('resets Lookups at once to the shipped default, offering it only when the applied value differs', () => {
    const shipped = CHAT_AGENT_DEFAULTS.max_parallel;
    const bounded = (max_tool_calls: number, max_parallel: number) => ({
      limits_mode: 'bounded' as const,
      max_tool_calls,
      max_parallel,
    });
    // Bounded at the default budget: the default applies 10, so a stored 12 or 10 shows 10
    // with no Reset (the value shown comes back), and a lower value resets to 12, not 10.
    expect(parallelFieldDefault(bounded(10, shipped))).toBe(10);
    expect(parallelFieldDefault(bounded(10, 10))).toBe(10);
    expect(parallelFieldDefault(bounded(10, 9))).toBe(shipped);
    expect(parallelFieldDefault(bounded(3, 3))).toBe(3);
    expect(parallelFieldDefault(bounded(3, 1))).toBe(shipped);
    // A budget at or above the default: the field behaves as in Unlimited.
    expect(parallelFieldDefault(bounded(20, shipped))).toBe(shipped);
    expect(parallelFieldDefault(bounded(20, 20))).toBe(shipped);
    expect(parallelFieldDefault(bounded(20, 4))).toBe(shipped);
    // Unlimited: the lookup budget is no cap.
    expect(parallelFieldDefault({ limits_mode: 'unlimited', max_tool_calls: 3, max_parallel: 8 })).toBe(shipped);
    expect(parallelFieldDefault({ limits_mode: 'unlimited', max_tool_calls: 10, max_parallel: shipped })).toBe(shipped);

    // Over every reachable value: Reset is offered exactly when the default would apply a
    // different value than the one shown, and it always stores the shipped default.
    const [toolLo, toolHi] = CHAT_AGENT_BOUNDS.max_tool_calls;
    const [parLo, parHi] = CHAT_AGENT_BOUNDS.max_parallel;
    for (const limits_mode of ['bounded', 'unlimited'] as const) {
      for (let max_tool_calls = toolLo; max_tool_calls <= toolHi; max_tool_calls += 1) {
        for (let max_parallel = parLo; max_parallel <= parHi; max_parallel += 1) {
          const cfg = { limits_mode, max_tool_calls, max_parallel };
          const shown = effectiveParallel(cfg);
          const target = parallelFieldDefault(cfg);
          const differs = shown !== effectiveParallel({ ...cfg, max_parallel: shipped });
          expect(target !== shown).toBe(differs);
          if (differs) expect(target).toBe(shipped);
        }
      }
    }
  });

  it('pins the backend rule it mirrors (computed at use, never stored)', () => {
    const source = readFileSync(path.resolve(process.cwd(), '..', 'backend', 'app', 'config.py'), 'utf8');
    const coherent = source.slice(source.indexOf('def _coherent(self) -> "ChatAgentConfig"'));
    const body = coherent.slice(0, coherent.indexOf('return self'));
    expect(body).not.toContain('self.max_parallel =');
    const effective = source.slice(source.indexOf('def effective_parallel(self) -> int:'));
    expect(effective.slice(0, 800)).toContain('return max(1, min(self.max_parallel, self.max_tool_calls))');
  });

  it('never shares the stored domain list (edits cannot mutate the saved prefs)', () => {
    const stored = { internal_domains: ['corp.example'] };
    const cfg = coherentChatAgent(stored);
    cfg.internal_domains.push('x.example');
    expect(stored.internal_domains).toEqual(['corp.example']);
  });
});

describe('normaliseInternalDomain (the twin of normalise_domains)', () => {
  it('lower-cases and strips a wildcard and stray dots', () => {
    expect(normaliseInternalDomain('  *.Corp.Example. ')).toBe('corp.example');
    expect(normaliseInternalDomain('*.*.lab.internal')).toBe('lab.internal');
    expect(normaliseInternalDomain('.internal')).toBe('internal');
  });

  it('refuses what the backend would drop', () => {
    for (const bad of ['', '*.', 'not a domain', 'a..b', 'https://corp.example', `${'a'.repeat(64)}.example`, 'ex@mple.com']) {
      expect(normaliseInternalDomain(bad), bad).toBeNull();
    }
  });
});

/* ------------------------------------------------------------ rendering ---- */

describe('ChatAgentSection', () => {
  it('shows the groups, the limits mode first, and no per-question knobs in unlimited mode', () => {
    renderSection(CHAT_AGENT_DEFAULTS);
    expect(screen.getByRole('heading', { name: 'Chat assistant' })).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Question limits', 'Spending', 'Answers', 'Suggestions', 'Timeouts and capacity', 'Indicator lookups']);
    const group = screen.getByRole('radiogroup', { name: 'Limits per question' });
    expect(within(group).getByRole('radio', { name: 'Unlimited' })).toBeChecked();
    expect(screen.getByTestId('chat-limits-help')).toHaveTextContent(LIMITS_MODE_HELP.unlimited);
    expect(screen.getByTestId('chat-limits-help')).toHaveTextContent(/never cut short/);
    expect(screen.getByTestId('chat-limits-help')).toHaveTextContent(/Loop guards still apply/);
    for (const label of ['Model calls', 'Lookups', 'Token ceiling', 'Time limit']) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'More limits' })).not.toBeInTheDocument();
  });

  it('shows the stored bounded values over the defaults', () => {
    renderSection({ ...BOUNDED, max_model_calls: 7 });
    expect(within(screen.getByRole('radiogroup', { name: 'Limits per question' })).getByRole('radio', { name: 'Bounded' })).toBeChecked();
    expect(screen.getByTestId('chat-limits-help')).toHaveTextContent(LIMITS_MODE_HELP.bounded);
    expect(screen.getByLabelText('Model calls')).toHaveValue('7');
    expect(screen.getByLabelText('Lookups')).toHaveValue('10');
    expect(screen.getByLabelText('Token ceiling')).toHaveValue('60000');
  });

  it('switches modes with one patch and keeps the stored knob values (lossless)', () => {
    const { lastPatch, unmount } = renderSection({ ...CHAT_AGENT_DEFAULTS, max_model_calls: 9 });
    fireEvent.click(screen.getByRole('radio', { name: 'Bounded' }));
    expect(lastPatch().limits_mode).toBe('bounded');
    expect(lastPatch().max_model_calls).toBe(9);
    unmount();

    const second = renderSection({ ...BOUNDED, max_model_calls: 9 });
    fireEvent.click(screen.getByRole('radio', { name: 'Unlimited' }));
    expect(second.lastPatch().limits_mode).toBe('unlimited');
    expect(second.lastPatch().max_model_calls).toBe(9);
  });

  it('renders with defaults when the backend omits the block', () => {
    renderSection();
    expect(screen.getByRole('radio', { name: 'Unlimited' })).toBeChecked();
    expect(screen.getByLabelText('Per question')).toHaveValue('3');
    expect(screen.getByLabelText('Per conversation')).toHaveValue('10');
  });

  it('writes one chat_agent patch and clamps a typed value into the backend range', () => {
    const { lastPatch } = renderSection(BOUNDED);
    commitNumber('Model calls', '99');
    expect(lastPatch().max_model_calls).toBe(12);
    expect(lastPatch().max_tool_calls).toBe(10);
    expect(lastPatch().limits_mode).toBe('bounded');
  });

  it('shows the batch size that applies when the lookup budget drops below it, without saving it', () => {
    const { lastPatch, rerender } = renderSection(BOUNDED);
    commitNumber('Lookups', '2');
    expect(lastPatch().max_tool_calls).toBe(2);
    // The stored value is kept (switching back to Unlimited must not lose it).
    expect(lastPatch().max_parallel).toBe(CHAT_AGENT_DEFAULTS.max_parallel);
    rerender(
      <TooltipProvider>
        <ChatAgentSection prefs={{ chat_agent: lastPatch() } as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    const field = screen.getByLabelText('Lookups at once');
    expect(field).toHaveValue('2');
    // Tabbing through the field never writes the shown value back, and no reset is
    // offered for a value the operator did not change.
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(lastPatch().max_parallel).toBe(CHAT_AGENT_DEFAULTS.max_parallel);
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
    // A value the operator did lower still offers the reset (the same query finds it, so
    // the absence check above is a real one).
    rerender(
      <TooltipProvider>
        <ChatAgentSection prefs={{ chat_agent: { ...BOUNDED, max_parallel: 2 } } as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    expect(within(fieldRoot('Lookups at once')).getByRole('button', RESET)).toBeInTheDocument();
  });

  it('Reset in Bounded mode stores the shipped default, so Unlimited shows it with no reset', () => {
    const { lastPatch, rerender } = renderSection({ ...BOUNDED, max_parallel: 9 });
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('9');
    fireEvent.click(within(fieldRoot('Lookups at once')).getByRole('button', RESET));
    // Not the effective default the field shows (10): Bounded runs the same either way.
    expect(lastPatch().max_parallel).toBe(CHAT_AGENT_DEFAULTS.max_parallel);
    expect(lastPatch().limits_mode).toBe('bounded');
    rerender(
      <TooltipProvider>
        <ChatAgentSection prefs={{ chat_agent: lastPatch() } as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('10');
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
    rerender(
      <TooltipProvider>
        <ChatAgentSection prefs={{ chat_agent: { ...lastPatch(), limits_mode: 'unlimited' } } as Preferences} update={vi.fn()} />
      </TooltipProvider>,
    );
    expect(screen.getByLabelText('Lookups at once')).toHaveValue(String(CHAT_AGENT_DEFAULTS.max_parallel));
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
  });

  it('stores a stepped value as entered, and Reset gives back the shipped default (SPEC D1)', () => {
    // A host that keeps the unsaved draft like the Settings page does.
    function Host() {
      const [prefs, setPrefs] = React.useState({ chat_agent: { ...CHAT_AGENT_DEFAULTS } } as Preferences);
      return (
        <TooltipProvider>
          <ChatAgentSection prefs={prefs} update={(patch) => setPrefs((p) => ({ ...p, ...patch }) as Preferences)} />
          <output data-testid="stored-parallel">{String(prefs.chat_agent?.max_parallel)}</output>
        </TooltipProvider>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('radio', { name: 'Bounded' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    const field = screen.getByLabelText('Lookups at once');
    expect(field).toHaveValue('10');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('9');
    fireEvent.click(within(fieldRoot('Lookups at once')).getByRole('button', RESET));
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent(String(CHAT_AGENT_DEFAULTS.max_parallel));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('10');
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
    // A step back up to the budget stores what the operator stepped to, not the default.
    fireEvent.keyDown(screen.getByLabelText('Lookups at once'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByLabelText('Lookups at once'), { key: 'ArrowUp' });
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('10');
    // Bounded runs 10 either way, so no Reset there; Unlimited shows the 10 and offers it.
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('10');
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Unlimited' }));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('10');
    fireEvent.click(within(fieldRoot('Lookups at once')).getByRole('button', RESET));
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent(String(CHAT_AGENT_DEFAULTS.max_parallel));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue(String(CHAT_AGENT_DEFAULTS.max_parallel));
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
  });

  it('stores a value typed at the Bounded cap as typed, so a wider budget or Unlimited runs it', () => {
    // A host that keeps the unsaved draft like the Settings page does.
    function Host() {
      const [prefs, setPrefs] = React.useState({
        chat_agent: { ...CHAT_AGENT_DEFAULTS, limits_mode: 'bounded', max_tool_calls: 8, max_parallel: 4 },
      } as Preferences);
      return (
        <TooltipProvider>
          <ChatAgentSection prefs={prefs} update={(patch) => setPrefs((p) => ({ ...p, ...patch }) as Preferences)} />
          <output data-testid="stored-parallel">{String(prefs.chat_agent?.max_parallel)}</output>
        </TooltipProvider>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('4');
    commitNumber('Lookups at once', '8');
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('8');
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('8');
    // A wider per-question budget keeps the operator's 8, never a substituted default.
    commitNumber('Lookups', '20');
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('8');
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('8');
    fireEvent.click(screen.getByRole('radio', { name: 'Unlimited' }));
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('8');
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('8');
    expect(within(fieldRoot('Lookups at once')).getByRole('button', RESET)).toBeInTheDocument();
  });

  it('keeps Lookups at once through a Bounded → Unlimited round trip', () => {
    // A host that keeps the unsaved draft like the Settings page does.
    function Host({ initial }: { initial: ChatAgentConfig }) {
      const [prefs, setPrefs] = React.useState({ chat_agent: initial } as Preferences);
      return (
        <TooltipProvider>
          <ChatAgentSection prefs={prefs} update={(patch) => setPrefs((p) => ({ ...p, ...patch }) as Preferences)} />
          <output data-testid="stored-parallel">{String(prefs.chat_agent?.max_parallel)}</output>
        </TooltipProvider>
      );
    }
    render(<Host initial={{ ...CHAT_AGENT_DEFAULTS, limits_mode: 'unlimited', max_tool_calls: 3, max_parallel: 8 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('8');
    fireEvent.click(screen.getByRole('radio', { name: 'Bounded' }));
    // Bounded shows what applies (at most Lookups per question) …
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('3');
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('8');
    fireEvent.click(screen.getByRole('radio', { name: 'Unlimited' }));
    // … and Unlimited gets the operator's value back.
    expect(screen.getByTestId('stored-parallel')).toHaveTextContent('8');
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('8');
  });

  it('never caps Lookups at once by the hidden lookup budget in unlimited mode, and says so in bounded mode', () => {
    // An operator once set Bounded → Lookups 3, then switched to Unlimited.
    const { lastPatch, unmount } = renderSection({ ...CHAT_AGENT_DEFAULTS, max_tool_calls: 3, max_parallel: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    const field = screen.getByLabelText('Lookups at once');
    expect(field).toHaveAccessibleDescription('Run side by side in one step.');
    const group = field.closest('div.flex') as HTMLElement;
    expect(within(group).getByRole('button', { name: 'Increase' })).toBeEnabled();
    commitNumber('Lookups at once', '8');
    expect(lastPatch().max_parallel).toBe(8);
    expect(lastPatch().max_tool_calls).toBe(3);
    unmount();

    renderSection({ ...BOUNDED, max_tool_calls: 3, max_parallel: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    expect(screen.getByLabelText('Lookups at once')).toHaveAccessibleDescription(
      'Run side by side in one step. At most Lookups per question (3) in Bounded mode.',
    );
  });

  it('shows the Timeouts and capacity defaults, and 10 lookups at once in Bounded mode (SPEC §4.2.3)', () => {
    const { unmount } = renderSection(CHAT_AGENT_DEFAULTS);
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    expect(screen.getByLabelText('Lookups at once')).toHaveValue('12');
    expect(screen.getByLabelText('Lookup timeout')).toHaveValue('45');
    expect(screen.getByLabelText('Model call timeout')).toHaveValue('900');
    expect(screen.getByLabelText('Questions at once per user')).toHaveValue('12');
    expect(screen.getByLabelText('Questions at once in total')).toHaveValue('48');
    unmount();

    // Bounded at the shipped defaults: one step runs at most Lookups per question (10)
    // of the 12, the hint says so, and no reset is offered for a value nobody changed.
    const { update } = renderSection(BOUNDED);
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    const field = screen.getByLabelText('Lookups at once');
    expect(field).toHaveValue('10');
    expect(field).toHaveAccessibleDescription(
      'Run side by side in one step. At most Lookups per question (10) in Bounded mode.',
    );
    expect(within(fieldRoot('Lookups at once')).queryByRole('button', RESET)).toBeNull();
    // Tabbing through never writes the shown 10 over the stored 12.
    fireEvent.focus(field);
    fireEvent.blur(field);
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts the wider ranges and clamps at their new ends', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    commitNumber('Lookups at once', '24');
    expect(lastPatch().max_parallel).toBe(24);
    commitNumber('Lookups at once', '99');
    expect(lastPatch().max_parallel).toBe(24);
    commitNumber('Model call timeout', '1800');
    expect(lastPatch().model_step_timeout_s).toBe(1_800);
    commitNumber('Model call timeout', '5000');
    expect(lastPatch().model_step_timeout_s).toBe(1_800);
    commitNumber('Questions at once per user', '24');
    expect(lastPatch().max_concurrent_turns_per_user).toBe(24);
    commitNumber('Questions at once per user', '50');
    expect(lastPatch().max_concurrent_turns_per_user).toBe(24);
    commitNumber('Lookup timeout', '500');
    expect(lastPatch().tool_timeout_s).toBe(120);
  });

  it('links each mode switch to its explanation, read politely when it changes', () => {
    renderSection(CHAT_AGENT_DEFAULTS);
    const limits = screen.getByRole('radiogroup', { name: 'Limits per question' });
    expect(limits).toHaveAccessibleDescription(LIMITS_MODE_HELP.unlimited);
    expect(screen.getByTestId('chat-limits-help')).toHaveAttribute('aria-live', 'polite');
    const typed = screen.getByRole('radiogroup', { name: 'Typed-out answers' });
    expect(typed).toHaveAccessibleDescription(TYPED_ANSWERS_HELP.allowed_off);
    expect(screen.getByTestId('typed-answers-help')).toHaveAttribute('aria-live', 'polite');
  });

  it('keeps the bounded long tail behind More limits, reachable and editable', () => {
    const { lastPatch } = renderSection(BOUNDED);
    expect(screen.queryByLabelText('Answer reserve')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More limits' }));
    for (const label of ['Answer reserve', 'Answer length', 'Results per step']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    commitNumber('Answer length', '100');
    expect(lastPatch().final_max_tokens).toBe(256);
  });

  it('keeps the knobs that apply in both modes reachable in unlimited mode', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    expect(screen.queryByLabelText('Lookup timeout')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    for (const label of [
      'Lookups at once',
      'Lookup timeout',
      'Model call timeout',
      'Questions at once per user',
      'Questions at once in total',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    commitNumber('Questions at once in total', '0');
    expect(lastPatch().max_concurrent_turns_global).toBe(1);
    expect(lastPatch().limits_mode).toBe('unlimited');
  });

  it('every knob of the block is reachable from the editor', () => {
    renderSection(BOUNDED);
    fireEvent.click(screen.getByRole('button', { name: 'More limits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    // 4 main + 3 more + 5 capacity + 2 indicator lookups = every numeric knob, each one a
    // labelled NumberField (counted by its numeric input, whatever role it exposes).
    const fields = [...document.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')];
    expect(fields).toHaveLength(Object.keys(CHAT_AGENT_BOUNDS).length);
    for (const field of fields) expect(field).toHaveAccessibleName();
  });

  it('turns the chat daily spending limit on, edits it and turns it off (SPEC D5)', () => {
    const { lastPatch, unmount } = renderSection(CHAT_AGENT_DEFAULTS);
    const cap = screen.getByRole('switch', { name: 'Daily chat spending limit' });
    expect(cap).not.toBeChecked();
    expect(screen.queryByLabelText('Limit per day')).not.toBeInTheDocument();
    expect(screen.getByText(/never pauses chat/)).toBeInTheDocument();
    fireEvent.click(cap);
    expect(lastPatch().chat_daily_cap_usd).toBe(CHAT_CAP_STARTING_USD);
    unmount();

    const second = renderSection({ ...CHAT_AGENT_DEFAULTS, chat_daily_cap_usd: 5 });
    expect(screen.getByRole('switch', { name: 'Daily chat spending limit' })).toBeChecked();
    commitNumber('Limit per day', '12.5');
    expect(second.lastPatch().chat_daily_cap_usd).toBe(12.5);
    fireEvent.click(screen.getByRole('switch', { name: 'Daily chat spending limit' }));
    expect(second.lastPatch().chat_daily_cap_usd).toBeNull();
  });

  it('reads 0 as "no limit" like the backend, never as a one-cent limit', () => {
    expect(chatCapFromField(0)).toBeNull();
    expect(chatCapFromField(-3)).toBeNull();
    expect(chatCapFromField(Number.NaN)).toBeNull();
    expect(chatCapFromField(0.5)).toBe(0.5);
    vi.useFakeTimers();
    try {
      const { lastPatch } = renderSection({ ...CHAT_AGENT_DEFAULTS, chat_daily_cap_usd: 12.5 });
      expect(screen.getByLabelText('Limit per day')).toHaveAccessibleDescription(/0 turns the limit off/);
      // A cleared field goes back to the starting amount, not to one cent.
      commitNumber('Limit per day', '');
      expect(lastPatch().chat_daily_cap_usd).toBe(CHAT_CAP_STARTING_USD);
      // 0 turns the limit off; focus that fell with the field goes to the switch.
      commitNumber('Limit per day', '0');
      expect(lastPatch().chat_daily_cap_usd).toBeNull();
      (document.activeElement as HTMLElement | null)?.blur();
      act(() => vi.runAllTimers());
      expect(screen.getByRole('switch', { name: 'Daily chat spending limit' })).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it('steps the daily limit by whole dollars, keeping typed cents', () => {
    const stepper = (name: 'Increase' | 'Decrease') =>
      within(screen.getByLabelText('Limit per day').closest('div.flex') as HTMLElement).getByRole('button', { name });
    const up = renderSection({ ...CHAT_AGENT_DEFAULTS, chat_daily_cap_usd: 5 });
    fireEvent.click(stepper('Increase'));
    expect(up.lastPatch().chat_daily_cap_usd).toBe(6);
    commitNumber('Limit per day', '7.25');
    expect(up.lastPatch().chat_daily_cap_usd).toBe(7.25);
    up.unmount();
    const down = renderSection({ ...CHAT_AGENT_DEFAULTS, chat_daily_cap_usd: 5 });
    fireEvent.click(stepper('Decrease'));
    expect(down.lastPatch().chat_daily_cap_usd).toBe(4);
    down.unmount();
    // − below a dollar reaches 0: the limit is off (no negative or one-cent limit).
    const low = renderSection({ ...CHAT_AGENT_DEFAULTS, chat_daily_cap_usd: 0.5 });
    fireEvent.click(stepper('Decrease'));
    expect(low.lastPatch().chat_daily_cap_usd).toBeNull();
  });

  it('maps the one Typed-out answers control onto the two stored fields (T31)', () => {
    expect(typedAnswers({ allow_text_streaming: false, default_stream_mode: 'text' })).toBe('off');
    expect(typedAnswers({ allow_text_streaming: true, default_stream_mode: 'steps' })).toBe('allowed_off');
    expect(typedAnswers({ allow_text_streaming: true, default_stream_mode: 'text' })).toBe('allowed_on');
    expect(typedAnswersPatch('off')).toEqual({ allow_text_streaming: false, default_stream_mode: 'steps' });
    expect(typedAnswersPatch('allowed_off')).toEqual({ allow_text_streaming: true, default_stream_mode: 'steps' });
    expect(typedAnswersPatch('allowed_on')).toEqual({ allow_text_streaming: true, default_stream_mode: 'text' });

    const { lastPatch, unmount } = renderSection(CHAT_AGENT_DEFAULTS);
    const group = screen.getByRole('radiogroup', { name: 'Typed-out answers' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Off',
      'Allowed (off by default)',
      'Allowed (on by default)',
    ]);
    expect(within(group).getByRole('radio', { name: 'Allowed (off by default)' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Allowed (on by default)' }));
    expect(lastPatch()).toMatchObject({ allow_text_streaming: true, default_stream_mode: 'text' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Off' }));
    expect(lastPatch()).toMatchObject({ allow_text_streaming: false, default_stream_mode: 'steps' });
    // One control: the old pair is gone.
    expect(screen.queryByRole('switch', { name: 'Allow typed-out answers' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Default live mode' })).toBeNull();
    unmount();

    // What viewers actually get is shown: not allowed reads Off whatever the stored default.
    renderSection({ ...CHAT_AGENT_DEFAULTS, default_stream_mode: 'text', allow_text_streaming: false });
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(screen.getByTestId('typed-answers-help')).toHaveTextContent(TYPED_ANSWERS_HELP.off);
  });

  it('turns live-data suggestions off and on (T31; a stored config without it reads as on)', () => {
    const { lastPatch } = renderSection({ ...CHAT_AGENT_DEFAULTS, dynamic_starters: undefined });
    const toggle = screen.getByRole('switch', { name: 'Suggest questions from live data' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(DYNAMIC_STARTERS_HELP);
    fireEvent.click(toggle);
    expect(lastPatch().dynamic_starters).toBe(false);
    expect(coherentChatAgent({ dynamic_starters: false }).dynamic_starters).toBe(false);
    expect(coherentChatAgent({}).dynamic_starters).toBe(true);
  });

  it('toggles e-mail lookups', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    fireEvent.click(screen.getByRole('switch', { name: 'Allow e-mail lookups' }));
    expect(lastPatch().allow_email_lookup).toBe(true);
  });

  it('turns the logo ring off and on (SPEC D13; a stored config without it reads as on)', () => {
    const { lastPatch } = renderSection({ ...CHAT_AGENT_DEFAULTS, animated_brand: undefined });
    const ring = screen.getByRole('switch', { name: 'Animate the logo while chat works' });
    expect(ring).toBeChecked();
    fireEvent.click(ring);
    expect(lastPatch().animated_brand).toBe(false);
  });

  it('passes the migration marker through untouched', () => {
    const { lastPatch } = renderSection({ ...CHAT_AGENT_DEFAULTS, chat_limits_version: 1 });
    fireEvent.click(screen.getByRole('switch', { name: 'Allow e-mail lookups' }));
    expect(lastPatch().chat_limits_version).toBe(1);
  });

  it('adds internal domains in their stored form and refuses an invalid one', () => {
    const { update, lastPatch } = renderSection({ ...CHAT_AGENT_DEFAULTS, internal_domains: ['lab.internal'] });
    const input = screen.getByLabelText('Internal domains');
    fireEvent.change(input, { target: { value: '*.Corp.Example' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lastPatch().internal_domains).toEqual(['lab.internal', 'corp.example']);

    update.mockClear();
    fireEvent.change(input, { target: { value: 'not a domain' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/domain suffix/i);
  });

  it('has no axe violations in either mode', async () => {
    const { container, unmount } = renderSection({ ...BOUNDED, chat_daily_cap_usd: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'More limits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show timeouts and capacity' }));
    expect(await axe(container)).toHaveNoViolations();
    unmount();
    const second = renderSection(CHAT_AGENT_DEFAULTS);
    expect(await axe(second.container)).toHaveNoViolations();
  });
});
