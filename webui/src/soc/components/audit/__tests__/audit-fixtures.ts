/** Shared fixtures for the Audit log tests: records and pages in the read API's shape. */
import type { AuditPage, AuditRecord } from '@/lib/types-audit';

export function rec(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    record_id: 'mem:1',
    event_id: null,
    app_version: '0.1.13',
    build_sha: 'abcdef1234567890',
    ts: '2026-10-25T15:09:15Z',
    case_id: null,
    source_id: null,
    surface: 'settings',
    actor: 'trao',
    action_type: 'user_mgmt',
    model: null,
    prompt_excerpt: null,
    query_text: null,
    tool_name: null,
    tool_input: null,
    tool_output_summary: null,
    result_summary: null,
    outcome_derived: false,
    actor_type_derived: false,
    category: 'access',
    event_label: 'User changed',
    demo: false,
    truncated_fields: [],
    ...over,
  };
}

export function page(records: AuditRecord[], over: Partial<AuditPage> = {}): AuditPage {
  return {
    records,
    total: records.length,
    next_cursor: null,
    total_relation: 'eq',
    run_totals: {},
    retention: { hot_days: 180, warm_days: 90, volatile: false },
    ...over,
  };
}

/** `n` people rows, newest first, one minute apart. */
export function rows(n: number, start = 1): AuditRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const k = start + i;
    return rec({
      record_id: `mem:${k}`,
      ts: new Date(Date.UTC(2026, 9, 25, 15, 0) - k * 60_000).toISOString(),
      actor: k % 2 ? 'trao' : 'vpatel',
      actor_type: 'human',
      action: 'settings.updated',
      action_type: 'status',
      outcome: 'success',
      category: 'config',
      event_label: `Settings changed ${k}`,
      result_summary: `updated settings: chat_agent (${k})`,
    });
  });
}
