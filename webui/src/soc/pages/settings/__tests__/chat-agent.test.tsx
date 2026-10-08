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
 *   - keeps every knob reachable (the long tail sits behind "More limits"), because the
 *     generic All settings view no longer shows this block.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { ChatAgentConfig, Preferences } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';

import {
  CHAT_AGENT_BOUNDS,
  CHAT_AGENT_DEFAULTS,
  ChatAgentSection,
  MAX_INTERNAL_DOMAINS,
  coherentChatAgent,
  normaliseInternalDomain,
} from '../chat-agent';

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
    expect(CHAT_AGENT_DEFAULTS.internal_domains).toEqual([]);
    expect(source.slice(start)).toMatch(new RegExp(`_MAX_INTERNAL_DOMAINS: ClassVar\\[int\\] = ${MAX_INTERNAL_DOMAINS}\\b`));
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

  it('never lets one batch exceed the lookup budget', () => {
    expect(coherentChatAgent({ max_tool_calls: 2, max_parallel: 4 }).max_parallel).toBe(2);
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
  it('shows the three groups and the stored values over the defaults', () => {
    renderSection({ ...CHAT_AGENT_DEFAULTS, max_model_calls: 7 });
    expect(screen.getByRole('heading', { name: 'Chat assistant' })).toBeInTheDocument();
    for (const name of ['Answers', 'Per-question limits', 'Indicator lookups']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Model calls')).toHaveValue('7');
    expect(screen.getByLabelText('Lookups')).toHaveValue('10');
    expect(screen.getByLabelText('Token ceiling')).toHaveValue('60000');
  });

  it('renders with defaults when the backend omits the block', () => {
    renderSection();
    expect(screen.getByLabelText('Per question')).toHaveValue('3');
    expect(screen.getByLabelText('Per conversation')).toHaveValue('10');
  });

  it('writes one chat_agent patch and clamps a typed value into the backend range', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    commitNumber('Model calls', '99');
    expect(lastPatch().max_model_calls).toBe(12);
    expect(lastPatch().max_tool_calls).toBe(10);
  });

  it('repairs the batch size when the lookup budget drops below it', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    commitNumber('Lookups', '2');
    expect(lastPatch().max_tool_calls).toBe(2);
    expect(lastPatch().max_parallel).toBe(2);
  });

  it('keeps the long tail behind More limits, reachable and editable', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    expect(screen.queryByLabelText('Lookup timeout')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More limits' }));
    for (const label of [
      'Lookup timeout',
      'Model call timeout',
      'Answer reserve',
      'Answer length',
      'Results per step',
      'Questions at once per user',
      'Questions at once in total',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    commitNumber('Questions at once in total', '0');
    expect(lastPatch().max_concurrent_turns_global).toBe(1);
  });

  it('sets the default live mode, and disables typed answers when they are not allowed', () => {
    const { lastPatch, unmount } = renderSection(CHAT_AGENT_DEFAULTS);
    fireEvent.click(screen.getByRole('radio', { name: 'Type out answers' }));
    expect(lastPatch().default_stream_mode).toBe('text');
    unmount();

    renderSection({ ...CHAT_AGENT_DEFAULTS, default_stream_mode: 'text', allow_text_streaming: false });
    const group = screen.getByRole('radiogroup', { name: 'Default live mode' });
    expect(within(group).getByRole('radio', { name: 'Type out answers' })).toBeDisabled();
    // What viewers actually get is shown, not the stored preference.
    expect(within(group).getByRole('radio', { name: 'Live steps' })).toBeChecked();
    expect(screen.getByText(/arrive whole while typed-out answers are not allowed/i)).toBeInTheDocument();
  });

  it('toggles typed answers and e-mail lookups', () => {
    const { lastPatch } = renderSection(CHAT_AGENT_DEFAULTS);
    fireEvent.click(screen.getByRole('switch', { name: 'Allow typed-out answers' }));
    expect(lastPatch().allow_text_streaming).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Allow e-mail lookups' }));
    expect(lastPatch().allow_email_lookup).toBe(true);
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

  it('has no axe violations', async () => {
    const { container } = renderSection(CHAT_AGENT_DEFAULTS);
    fireEvent.click(screen.getByRole('button', { name: 'More limits' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
