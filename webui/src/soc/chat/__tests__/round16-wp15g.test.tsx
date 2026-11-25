/**
 * Round 16 WP15G (SPEC §4.5): chat exports and citations say what really happened.
 *
 * - B38: a conversation export names a log source only when a lookup read it, the
 *   server's `_scope_for` rule (`routes_reports.py`): the sources a tool step recorded,
 *   else the turn's source when a log tool ran without recording one, else none.
 * - B42: a case citation shows the case number; the internal id stays the target.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatCitation, ChatConversation, ChatStep } from '@/lib/types';

import { SourcesDisclosure } from '../message/SourcesDisclosure';
import { buildConversationDoc } from '../report/model';
import { normaliseCitation } from '../stream-events';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@/soc/router', () => ({ useNavigateOptional: () => mocks.navigate }));

const NOW = '2026-11-24T20:26:00Z';

function step(index: number, tool: string, sources?: string[]): ChatStep {
  return {
    index,
    ordinal: index,
    kind: 'tool',
    tool,
    label: tool,
    params: {},
    status: 'ok',
    duration_ms: 10,
    summary: '',
    ...(sources ? { sources } : {}),
  };
}

function conversation(steps: ChatStep[]): ChatConversation {
  return {
    id: 'conv-shift',
    title: 'Shift brief',
    created_at: '2026-11-24T20:00:00Z',
    updated_at: '2026-11-24T20:01:00Z',
    message_count: 2,
    messages: [
      { id: 'u-1', role: 'user', content: 'Give me the shift brief', created_at: '2026-11-24T20:00:00Z' },
      {
        id: 'a-1',
        role: 'assistant',
        content: 'Ten cases need attention.',
        created_at: '2026-11-24T20:00:05Z',
        source_name: 'Splunk Enterprise Security (HEC)',
        response: {
          answer: 'Ten cases need attention.',
          message_id: 'a-1',
          usage: null,
          steps,
          effective_source_name: 'Splunk Enterprise Security (HEC)',
        },
      },
    ],
  };
}

const methodologyText = (doc: ReturnType<typeof buildConversationDoc>) => doc.methodology.join('\n');

describe('B38: a conversation export names a source only when a lookup read it', () => {
  it('names no source for an answer built from the case store only', () => {
    const doc = buildConversationDoc(
      conversation([step(1, 'shift_snapshot', []), step(2, 'metrics'), step(3, 'list_campaigns', [])]),
      { generatedAt: NOW },
    );
    expect(doc.items[0].scope.sources).toEqual([]);
    expect(doc.sources).toEqual([]);
    expect(methodologyText(doc)).not.toMatch(/Sources queried/);
    expect(methodologyText(doc)).not.toMatch(/Splunk/);
  });

  it('names no source for an answer with no lookup at all', () => {
    const doc = buildConversationDoc(conversation([]), { generatedAt: NOW });
    expect(doc.items[0].scope.sources).toEqual([]);
    expect(methodologyText(doc)).not.toMatch(/Sources queried/);
  });

  it('credits the turn source when a log search ran without recording one', () => {
    const doc = buildConversationDoc(conversation([step(1, 'shift_snapshot'), step(2, 'search_logs')]), {
      generatedAt: NOW,
    });
    expect(doc.items[0].scope.sources).toEqual(['Splunk Enterprise Security (HEC)']);
    expect(methodologyText(doc)).toContain('Sources queried: Splunk Enterprise Security (HEC).');
  });

  it('names the sources a lookup recorded, not the turn source', () => {
    const doc = buildConversationDoc(conversation([step(1, 'log_stats', ['Wazuh']), step(2, 'search_cases', [])]), {
      generatedAt: NOW,
    });
    expect(doc.items[0].scope.sources).toEqual(['Wazuh']);
    expect(doc.sources).toEqual(['Wazuh']);
    expect(methodologyText(doc)).toContain('Sources queried: Wazuh.');
  });
});

const CASE_CITATION = {
  id: 'C1',
  kind: 'case',
  title: 'user:vpatel · LP QRadar: impossible travel authentication',
  case_id: 'demo-recent-00000539-0001',
  case_number: 'CASE-000043',
  untrusted: true,
};

describe('B42: a case citation shows the case number', () => {
  it('keeps the display number from the wire, and drops it on other kinds', () => {
    expect(normaliseCitation(CASE_CITATION)?.case_number).toBe('CASE-000043');
    expect(normaliseCitation({ ...CASE_CITATION, case_number: undefined })?.case_number).toBeNull();
    expect(normaliseCitation({ ...CASE_CITATION, case_number: 42 })?.case_number).toBeNull();
    const doc = normaliseCitation({ id: 'D1', kind: 'doc', title: 'Chat', doc: '/docs/0.2/analyst/chat/', case_number: 'X' });
    expect(doc?.case_number).toBeNull();
  });

  it('labels the chip with the number and opens the case by its id', () => {
    const citation = normaliseCitation(CASE_CITATION) as ChatCitation;
    mocks.navigate.mockReset();
    render(<SourcesDisclosure id="src" domId="m1" citations={[citation]} consoleLinks={[]} />);
    const chip = screen.getByRole('button', { name: 'CASE-000043' });
    expect(screen.queryByText('demo-recent-00000539-0001')).toBeNull();
    expect(chip).toHaveAttribute('title', 'demo-recent-00000539-0001');
    fireEvent.click(chip);
    expect(mocks.navigate).toHaveBeenCalledWith('case_manager', { caseId: 'demo-recent-00000539-0001' });
  });

  it('falls back to the id for a transcript stored before the number existed', () => {
    const citation = normaliseCitation({ ...CASE_CITATION, case_number: null }) as ChatCitation;
    mocks.navigate.mockReset();
    render(<SourcesDisclosure id="src" domId="m1" citations={[citation]} consoleLinks={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'demo-recent-00000539-0001' }));
    expect(mocks.navigate).toHaveBeenCalledWith('case_manager', { caseId: 'demo-recent-00000539-0001' });
  });
});
