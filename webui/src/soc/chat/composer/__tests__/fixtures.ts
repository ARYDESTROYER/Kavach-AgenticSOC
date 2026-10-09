/**
 * Shared composer test fixtures: a `/chat/context` with a realistic catalogue and a
 * builder for restricted roles. Plain data; every test builds on a fresh copy.
 */
import type { ChatContextInfo, ChatToolInfo } from '@/lib/types';
import { DEFAULT_CHAT_BOUNDS } from '../../chat-api';

const tool = (name: string, scope: ChatToolInfo['scope'], requires: string[], label = name): ChatToolInfo => ({
  name,
  label,
  scope,
  data_source: `${label} data`,
  requires,
  allowed: true,
  missing: [],
  kind_requires: {},
  kinds_allowed: [],
});

export const ALL_TOOLS: ChatToolInfo[] = [
  tool('search_logs', 'logs', ['sources:read'], 'Searched logs'),
  tool('log_stats', 'logs', ['sources:read'], 'Counted log events'),
  tool('search_cases', 'cases', ['cases:read'], 'Searched cases'),
  tool('get_case', 'cases', ['cases:read'], 'Read a case'),
  tool('shift_report', 'cases', ['cases:read'], 'Built a shift snapshot'),
  tool('soc_metrics', 'metrics', ['metrics:view'], 'Read SOC metrics'),
  tool('lookup_indicator', 'intel', ['enrichment:read'], 'Looked up an indicator'),
  tool('mitre_lookup', 'intel', [], 'Looked up ATT&CK'),
  tool('app_help', 'docs', [], 'Searched the Help Center'),
  tool('cost_usage', 'platform', ['cost:view'], 'Read AI spend'),
  tool('source_health', 'platform', ['sources:read'], 'Checked source health'),
];

/** A context whose catalogue allows everything except the listed tools. */
export function makeContext(
  overrides: Partial<ChatContextInfo> = {},
  deny: Record<string, string> = {},
): ChatContextInfo {
  const tools = ALL_TOOLS.map((t) =>
    t.name in deny ? { ...t, allowed: false, missing: [deny[t.name]] } : { ...t },
  );
  return {
    model: 'claude-sonnet-test',
    context_window: 200_000,
    max_output_tokens: 4_000,
    chars_per_token: 4,
    static_prompt_tokens: 1_000,
    history_tokens: 200,
    history_exchanges: 12,
    tools,
    text_streaming: { available: true, reason: null },
    bounds: { ...DEFAULT_CHAT_BOUNDS },
    calibration: null,
    budget_state: 'ok',
    rates: null,
    simulated: null,
    budget: null,
    spent_today: null,
    remaining: null,
    starters: [],
    ...overrides,
  };
}
