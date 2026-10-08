/**
 * Shared report fixtures for the report UI and export tests: a normalised `Report`
 * built from the answer-block gallery (so every block type and the adversarial cells —
 * `=HYPERLINK`, e-mail users, documentation IPs — are covered) plus a conversation with
 * recorded steps and usage.
 */
import type { ChatConversation, ChatStep, Report, ReportItem, TurnUsage } from '@/lib/types';

import { GALLERY_RAW } from '../../blocks/__fixtures__/gallery';

export const NOW = new Date(Date.UTC(2026, 9, 8, 14, 5, 0));

export function rawBlock(id: string): Record<string, unknown> {
  const found = (GALLERY_RAW as Array<Record<string, unknown>>).find((b) => b.id === id);
  if (!found) throw new Error(`no gallery block ${id}`);
  return JSON.parse(JSON.stringify(found)) as Record<string, unknown>;
}

export const USAGE: TurnUsage = {
  calls: 2,
  embedding_calls: 0,
  input_tokens: 1800,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 300,
  total_tokens: 2100,
  cost: 0.0042,
  latency_ms: 2100,
  model: 'demo-chat',
  pricing_source: 'demo',
  simulated: true,
  estimated: false,
  context_window: 128000,
  peak_prompt_tokens: 1500,
};

export const STEPS: ChatStep[] = [
  {
    index: 1,
    ordinal: 1,
    kind: 'tool',
    tool: 'log_stats',
    label: 'Counted log events',
    params: { source: 'Wazuh', window: 'last 24h' },
    status: 'ok',
    duration_ms: 420,
    summary: '1,284 events',
    query: 'event.outcome:failure AND source.ip:203.0.113.14',
    rows: 1284,
    basis: 'newest_n',
    coverage: 'newest 200 of 1,284',
    sources: ['Wazuh'],
  },
  {
    index: 2,
    ordinal: 2,
    kind: 'tool',
    tool: 'search_cases',
    label: 'Searched cases',
    params: {},
    status: 'timeout',
    duration_ms: 15000,
    summary: 'timed out',
    sources: [],
  },
  {
    index: 3,
    ordinal: null,
    kind: 'model',
    tool: null,
    label: 'Wrote the answer',
    params: {},
    status: 'ok',
    duration_ms: 900,
    summary: '',
    sources: [],
  },
];

function item(id: string, block: Record<string, unknown>, extra: Partial<ReportItem> = {}): ReportItem {
  return {
    id,
    kind: 'block',
    block,
    note: null,
    source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: String(block.id) },
    scope: { window: 'last 24h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
    added_at: '2026-10-08T13:00:00Z',
    ...extra,
  };
}

export function sampleReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'rep-1',
    owner: 'analyst',
    title: 'Brute force on vpn-gw-2',
    template: 'investigation',
    conversation_id: 'conv-1',
    items: [
      {
        id: 'it-1',
        kind: 'section',
        block: {
          title: 'Who is failing logins against vpn-gw-2?',
          blocks: [
            { id: 'answer', type: 'markdown', provenance: 'ai', text: '## Findings\n\nMost failures came from **203.0.113.14**; see http://evil.example/x and [docs](/docs/0.1/analyst/chat/).\n\n![img](http://evil.example/p.png) <script>alert(1)</script>' },
            rawBlock('kpis'),
          ],
          truncated: false,
        },
        note: 'Escalate to the network team.\nCheck the VPN logs.',
        source: { conversation_id: 'conv-1', message_id: 'msg-2', block_id: null },
        scope: { window: 'last 24h', sources: ['Wazuh'], generated_by: 'demo-chat', app_version: '0.1.13', demo: true },
        added_at: '2026-10-08T12:55:00Z',
      },
      item('it-2', rawBlock('signins'), { note: '=cmd|"/c calc"!A1' }),
      item('it-3', rawBlock('alerts-by-source')),
      item('it-4', rawBlock('lookup-query')),
      item('it-5', rawBlock('attack-coverage')),
      item('it-6', rawBlock('ioc'), { source: { conversation_id: 'conv-gone', message_id: 'msg-9', block_id: 'ioc' } }),
    ],
    summary: {
      executive_summary: 'Brute force from 203.0.113.14 against vpn-gw-2; no successful logins.',
      next_steps: ['Block 203.0.113.14 at the edge', 'Review MFA coverage'],
      model: 'demo-chat',
      usage: { ...USAGE, total_tokens: 1400, cost: 0.001 },
      generated_at: '2026-10-08T13:30:00Z',
      based_on_version: 4,
    },
    created_at: '2026-10-08T12:50:00Z',
    updated_at: '2026-10-08T13:40:00Z',
    version: 5,
    ...overrides,
  };
}

export function sampleConversation(): ChatConversation {
  return {
    id: 'conv-1',
    title: 'VPN brute force',
    created_at: '2026-10-08T12:00:00Z',
    updated_at: '2026-10-08T12:10:00Z',
    message_count: 2,
    messages: [
      { id: 'msg-1', role: 'user', content: 'Who is failing logins against vpn-gw-2?', created_at: '2026-10-08T12:00:00Z' },
      {
        id: 'msg-2',
        role: 'assistant',
        content: 'Most failures came from 203.0.113.14.',
        created_at: '2026-10-08T12:00:05Z',
        response: {
          answer: 'Most failures came from **203.0.113.14** (see http://evil.example/login).',
          blocks: [rawBlock('signins'), rawBlock('lookup-query')],
          steps: STEPS,
          usage: USAGE,
          message_id: 'msg-2',
        },
      },
    ],
  };
}
