import { describe, expect, it } from 'vitest';

import type { Report, ReportItem } from '@/lib/types';

import { reportItemIndex, reportItemKey } from '../report-sync';

function item(id: string, kind: ReportItem['kind'], messageId: string, blockId: string | null): ReportItem {
  return {
    id,
    kind,
    block: {},
    source: { conversation_id: 'chat-1', message_id: messageId, block_id: blockId },
    scope: { sources: [], demo: false },
    added_at: '2026-10-10T00:00:00Z',
  };
}

function report(items: ReportItem[]): Report {
  return {
    id: 'rpt-1', owner: '', title: 'Report', template: 'custom', items,
    created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', version: 2,
  };
}

describe('reportItemIndex', () => {
  it('maps a long whole answer to its first section, not a "(continued)" one', () => {
    // The server stores a whole answer longer than one section as its first section
    // plus continuation sections (source block id `#2`, normalised to null here).
    const index = reportItemIndex(report([
      item('item-a', 'section', 'm1', null),
      item('item-b', 'section', 'm1', null),
      item('item-c', 'section', 'm1', null),
      item('item-d', 'block', 'm1', 'b1'),
    ]));
    expect(index.get(reportItemKey('m1', null))).toBe('item-a');
    expect(index.get(reportItemKey('m1', 'b1'))).toBe('item-d');
  });

  it('is empty without a report', () => {
    expect(reportItemIndex(null).size).toBe(0);
  });
});
