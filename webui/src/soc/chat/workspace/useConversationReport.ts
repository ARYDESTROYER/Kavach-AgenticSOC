/**
 * useConversationReport — the open conversation's draft report as the transcript sees
 * it: which answers and blocks are already in it ("In report ✓"), and the add/remove
 * toggles behind every "Add to report" control (chat revamp SPEC §9.2, §10.6).
 *
 * Adds go BY REFERENCE (`POST /api/reports/add` with the saved message id and an
 * optional block id); the server snapshots the block and creates the conversation's
 * draft on the first add. A second click removes the item (`PATCH … remove_items`
 * with `expected_version`; a 409 reloads and asks to try again).
 *
 * The report panel lives in another lazy chunk; both sides stay current through the
 * shared `report-sync` window event: every change made here is emitted with the
 * server's copy, and every change the panel (or another surface) makes is applied
 * here, so the transcript's marks never drift from the panel.
 *
 * The toggles stay mounted while a request is in flight and when the report is full:
 * a click during a request is ignored (one request at a time), and adding to a full
 * report is refused locally with the reason, while an item already in a full report
 * can still be removed from the transcript. Visibility never depends on `pending`, so
 * the clicked control keeps focus and the layout does not shift.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import type { Report } from '@/lib/types';
import { addToReport, getReport, isSafeChatId, patchReport } from '../chat-api';
import {
  REPORT_FULL_MESSAGE,
  emitReportChanged,
  isVersionConflict,
  onReportChanged,
  reportErrorMessage,
  reportItemIndex,
  reportItemKey,
} from '../report/report-sync';
import type { ChatAssistantItem } from '../useChatEngine';
import type { MessageReportBinding } from '../message/Message';
import { CHAT_LIMITS } from '../stream-events';

const ORIGIN = 'chat-transcript';

export interface UseConversationReportOptions {
  /** The saved conversation, or null for a draft / case scope. */
  conversationId: string | null;
  /** The conversation's draft report as the rail row knows it. */
  reportId: string | null;
  /** Off for case-scoped chat (case content is never addable, SPEC §9.2). */
  enabled: boolean;
  /** An item was added here; `count` is the report's new item count. */
  onAdded?: (count: number, reportId: string) => void;
  /** An item was removed here. */
  onRemoved?: (count: number) => void;
  /** An add was refused locally (the report is full); the reason is shown as a toast too. */
  onRefused?: (reason: string) => void;
}

export interface ConversationReportController {
  report: Report | null;
  reportId: string | null;
  count: number;
  full: boolean;
  /** The binding one assistant message needs (null when it cannot be added). */
  bindingFor: (item: ChatAssistantItem) => MessageReportBinding | null;
}

export function useConversationReport({
  conversationId,
  reportId: knownReportId,
  enabled,
  onAdded,
  onRemoved,
  onRefused,
}: UseConversationReportOptions): ConversationReportController {
  const [report, setReport] = React.useState<Report | null>(null);
  const [reportId, setReportId] = React.useState<string | null>(knownReportId);
  // A ref, not state: an in-flight request must not rebuild every message's binding
  // (that re-rendered every block and unmounted the clicked toggle).
  const pendingRef = React.useRef(false);
  const generationRef = React.useRef(0);
  const callbacksRef = React.useRef({ onAdded, onRemoved, onRefused });
  callbacksRef.current = { onAdded, onRemoved, onRefused };

  const knownRef = React.useRef(knownReportId);
  knownRef.current = knownReportId;
  // The report each conversation was linked to HERE (an add created or used it; a
  // delete unlinked it). The rail row learns the link only on its next refresh, so
  // switching away and back must not fall back to its stale `null` ("Report · 0").
  const learnedRef = React.useRef(new Map<string, string | null>());
  const learn = React.useCallback((thread: string | null, id: string | null) => {
    if (thread) learnedRef.current.set(thread, id);
  }, []);
  // Another conversation: forget the previous report at once (no stale "In report").
  React.useEffect(() => {
    generationRef.current += 1;
    setReport(null);
    const learned = conversationId ? learnedRef.current.get(conversationId) : null;
    setReportId(enabled ? (learned ?? knownRef.current) : null);
  }, [conversationId, enabled]);

  // The rail learnt the thread's report id (e.g. after a refresh): adopt it without
  // dropping a copy of the same report that is already on screen.
  const currentIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (enabled && knownReportId && knownReportId !== currentIdRef.current) setReportId(knownReportId);
  }, [enabled, knownReportId]);

  const threadRef = React.useRef(conversationId);
  threadRef.current = conversationId;
  const load = React.useCallback(async (id: string) => {
    const generation = generationRef.current;
    try {
      const next = await getReport(id);
      if (generation === generationRef.current) setReport(next);
    } catch (error) {
      if (generation !== generationRef.current) return;
      // A deleted report: the next add creates a fresh draft.
      if (error instanceof ApiError && error.status === 404) {
        learn(threadRef.current, null);
        setReport(null);
        setReportId(null);
      }
    }
  }, [learn]);

  React.useEffect(() => {
    if (!enabled || !reportId || !isSafeChatId(reportId) || report?.id === reportId) return;
    void load(reportId);
  }, [enabled, load, report?.id, reportId]);

  // Changes made by the panel, the library or another tab's panel.
  const stateRef = React.useRef({ reportId, conversationId });
  stateRef.current = { reportId: report?.id ?? reportId, conversationId };
  React.useEffect(
    () =>
      onReportChanged((detail) => {
        if (detail.origin === ORIGIN) return;
        const { reportId: current, conversationId: thread } = stateRef.current;
        const mine =
          (current && detail.reportId === current) || (!!thread && detail.conversationId === thread);
        if (!mine) return;
        if (detail.report === null) {
          learn(thread, null);
          setReport(null);
          setReportId(null);
          return;
        }
        if (detail.report) {
          const next = detail.report;
          learn(thread, next.id);
          setReportId(next.id);
          // Never step back to an older copy than the one already shown.
          setReport((prev) => (prev && prev.id === next.id && prev.version > next.version ? prev : next));
          return;
        }
        const id = current ?? detail.reportId;
        if (id) void load(id);
      }),
    [learn, load],
  );

  currentIdRef.current = report?.id ?? reportId;
  const index = React.useMemo(() => reportItemIndex(report), [report]);
  // Block ids per message, read from the items themselves (ids may contain ':').
  const blocksByMessage = React.useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const item of report?.items ?? []) {
      if (item.kind === 'section' || !item.source.block_id) continue;
      const set = out.get(item.source.message_id) ?? new Set<string>();
      set.add(item.source.block_id);
      out.set(item.source.message_id, set);
    }
    return out;
  }, [report]);
  const count = report?.items.length ?? 0;
  const full = count >= CHAT_LIMITS.report_items;

  const add = React.useCallback(
    async (messageId: string, blockId: string | null) => {
      if (!conversationId || pendingRef.current) return;
      pendingRef.current = true;
      const generation = generationRef.current;
      try {
        const result = await addToReport({ conversationId, messageId, blockId, reportId: report?.id ?? reportId });
        if (generation !== generationRef.current) return;
        setReport(result.report);
        setReportId(result.report.id);
        learn(conversationId, result.report.id);
        emitReportChanged({ reportId: result.report.id, conversationId, report: result.report, origin: ORIGIN });
        callbacksRef.current.onAdded?.(result.report.items.length, result.report.id);
      } catch (error) {
        if (generation === generationRef.current) toast.error(reportErrorMessage(error, 'Could not add it to the report.'));
      } finally {
        pendingRef.current = false;
      }
    },
    [conversationId, learn, report?.id, reportId],
  );

  const remove = React.useCallback(
    async (itemId: string) => {
      if (!report || pendingRef.current) return;
      pendingRef.current = true;
      const generation = generationRef.current;
      try {
        const next = await patchReport(report.id, { expected_version: report.version, remove_items: [itemId] });
        if (generation !== generationRef.current) return;
        setReport(next);
        emitReportChanged({ reportId: next.id, conversationId, report: next, origin: ORIGIN });
        callbacksRef.current.onRemoved?.(next.items.length);
      } catch (error) {
        if (generation !== generationRef.current) return;
        toast.error(isVersionConflict(error) ? 'This report changed elsewhere. It was reloaded — try again.' : reportErrorMessage(error));
        if (isVersionConflict(error)) void load(report.id);
      } finally {
        pendingRef.current = false;
      }
    },
    [conversationId, load, report],
  );

  // Adding to a full report is refused here, with the reason, instead of hiding the
  // control (an item already in the report stays removable from the transcript).
  const refuseFull = React.useCallback(() => {
    toast(REPORT_FULL_MESSAGE);
    callbacksRef.current.onRefused?.(REPORT_FULL_MESSAGE);
  }, []);

  // One binding object per message until the report changes, so memoised messages and
  // their blocks do not re-render on every live transcript update (or on a request
  // starting): the cache lives inside the memoised function and is rebuilt with it.
  const bindingFor = React.useMemo(() => {
    const cache = new Map<string, MessageReportBinding>();
    return (item: ChatAssistantItem): MessageReportBinding | null => {
      if (!enabled || !conversationId) return null;
      const messageId = item.messageId;
      if (!isSafeChatId(messageId) || item.status !== 'done' || !item.response) return null;
      const cached = cache.get(messageId);
      if (cached) return cached;
      const blocks = blocksByMessage.get(messageId) ?? new Set<string>();
      const answerItem = index.get(reportItemKey(messageId, null)) ?? null;
      const binding: MessageReportBinding = {
        blocks,
        answerInReport: answerItem !== null,
        canAdd: !full,
        disabledReason: full ? REPORT_FULL_MESSAGE : null,
        onToggleBlock: (blockId: string) => {
          const itemId = index.get(reportItemKey(messageId, blockId));
          if (itemId) void remove(itemId);
          else if (full) refuseFull();
          else void add(messageId, blockId);
        },
        onToggleAnswer: () => {
          if (answerItem) void remove(answerItem);
          else if (full) refuseFull();
          else void add(messageId, null);
        },
      };
      cache.set(messageId, binding);
      return binding;
    };
  }, [add, blocksByMessage, conversationId, enabled, full, index, refuseFull, remove]);

  return { report, reportId: report?.id ?? reportId, count, full, bindingFor };
}
