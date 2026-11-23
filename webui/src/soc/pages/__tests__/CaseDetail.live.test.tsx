/**
 * CaseDetail — live SSE wiring regression (Wave 4 dead-code fix).
 *
 * Before this fix the live SSE handlers on <CaseThread> + <CaseActivityFeed> were
 * DEAD CODE: no caller in CaseDetail ever passed `liveCaseId` / `onLiveActivity`, so
 * the collaboration thread and activity feed never updated in real time. This spec
 * locks the wiring on two levels:
 *
 *   1. BEHAVIOURAL — the two components, when GIVEN the live props (exactly what the
 *      CaseDetail mount site now passes), subscribe to the per-case SSE room and fire
 *      `onLiveActivity` on a `case.activity` frame. The frame payload is never rendered
 *      (#9) — it only triggers the refetch callback; nothing decides anything (#3).
 *   2. STATIC — CaseDetail.tsx actually forwards `liveCaseId=` + the live-refresh
 *      handlers to BOTH <CaseThread> and <CaseActivityFeed>, so the wiring can't be
 *      silently dropped again and re-rot into dead code.
 *
 * useEventStream is mocked so the test is hermetic (no real EventSource / network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/* ---- Mock the live transport: capture topics + options, expose the onEvent. ---- */

type StreamOpts = { enabled?: boolean; onEvent?: (ev: { type: string }) => void };
const streamCalls: Array<{ topics: string[]; opts: StreamOpts }> = [];
vi.mock('@/lib/useEventStream', () => ({
  useEventStream: (topics: string[], opts: StreamOpts = {}) => {
    streamCalls.push({ topics, opts });
    return { live: false };
  },
}));

import { CaseThread } from '../../components/CaseThread';
import { CaseActivityFeed } from '../../components/CaseActivityFeed';
import type { CaseMessage } from '../CaseDetail.api';

const NOOP_THREAD = {
  onPost: vi.fn(),
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onReact: vi.fn(),
};

function lastCall() {
  return streamCalls[streamCalls.length - 1];
}

beforeEach(() => {
  streamCalls.length = 0;
});

describe('CaseDetail live SSE wiring (Wave 4 dead-code fix)', () => {
  it('CaseThread subscribes to cases:{id} and nudges onLiveActivity on a case.activity frame', () => {
    const onLiveActivity = vi.fn();
    const msgs: CaseMessage[] = [];
    render(
      <CaseThread
        messages={msgs}
        users={[]}
        currentUser={null}
        canComment={false}
        liveCaseId="case-7777"
        onLiveActivity={onLiveActivity}
        {...NOOP_THREAD}
      />,
    );
    const call = lastCall();
    expect(call.topics).toEqual(['cases:case-7777']);
    expect(call.opts.enabled).toBe(true);
    // A live frame is a NUDGE → refetch handler fires; payload is never rendered (#9).
    call.opts.onEvent?.({ type: 'case.activity' });
    expect(onLiveActivity).toHaveBeenCalledTimes(1);
    // Round 15 (WP7): the frame goes with the nudge, so the caller can tell a screenshot
    // frame (`ref.file_id`) from a thread one on this one stream.
    expect(onLiveActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'case.activity' }));
    // A non-activity frame must NOT trigger a refetch.
    call.opts.onEvent?.({ type: 'inapp' });
    expect(onLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('CaseThread without liveCaseId stays inert (default-off polling fallback)', () => {
    render(
      <CaseThread
        messages={[]}
        users={[]}
        currentUser={null}
        canComment={false}
        {...NOOP_THREAD}
      />,
    );
    const call = lastCall();
    expect(call.topics).toEqual([]);
    expect(call.opts.enabled).toBe(false);
  });

  it('CaseActivityFeed subscribes to cases:{id} and nudges onLiveActivity on a frame', () => {
    const onLiveActivity = vi.fn();
    render(
      <CaseActivityFeed
        items={[]}
        liveCaseId="case-7777"
        onLiveActivity={onLiveActivity}
      />,
    );
    const call = lastCall();
    expect(call.topics).toEqual(['cases:case-7777']);
    expect(call.opts.enabled).toBe(true);
    call.opts.onEvent?.({ type: 'case.activity' });
    expect(onLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('names its blocking activity load and reserves the timeline footprint', () => {
    render(<CaseActivityFeed items={[]} loading />);

    const status = screen.getByRole('status', { name: 'Loading case activity' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveClass('min-h-[14.25rem]');
    expect(status.querySelector('[data-loading-shape="rows"]')).not.toBeNull();
  });

  it('STATIC: CaseDetail forwards liveCaseId + live handlers to both surfaces', () => {
    // COUPLING-D: the mount site (orchestrator) forwards the live props to the
    // Collaboration panel; the panel (CollaborationPanel.tsx) threads them into BOTH
    // <CaseThread> and <CaseActivityFeed>. Assert each half against its file.
    const src = readFileSync(
      path.resolve(__dirname, '..', 'CaseDetail.tsx'),
      'utf8',
    );
    const collabSrc = readFileSync(
      path.resolve(__dirname, '..', 'casedetail', 'CollaborationPanel.tsx'),
      'utf8',
    );
    // The orchestrator mount site must pass the live props from the CaseDetail state…
    expect(src).toMatch(/liveCaseId=\{id\}/);
    expect(src).toMatch(/onLiveThread=\{liveRefreshThread\}/);
    expect(src).toMatch(/onLiveActivity=\{liveRefreshActivity\}/);
    // …and the Collaboration panel threads them into BOTH the thread and the feed.
    expect(collabSrc).toMatch(/onLiveActivity=\{onLiveThread\}/); // → <CaseThread>
    expect(collabSrc).toMatch(/onLiveActivity=\{onLiveActivity\}/); // → <CaseActivityFeed>
    expect((collabSrc.match(/liveCaseId=\{liveCaseId\}/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
