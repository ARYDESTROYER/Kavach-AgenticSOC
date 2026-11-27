/**
 * The conversation export runner (history rail ⋯ › Export and the thread toolbar's ⋯
 * menu), held to the same discipline as the report export runner (`useReportExport`,
 * Round 12 SPEC WP-REP R1, R2, R3, R17):
 *
 *   - In-flight guard: one export per conversation at a time. Reading a long thread
 *     pages through every older window first, so a second pick while it runs is ignored
 *     (it used to save two files or open two print dialogs).
 *   - Visible progress: the menu has closed by then, so a loading toast ("Preparing
 *     Markdown…", also announced) stays up until the result replaces it.
 *   - Visible result: a success toast with the file name (announced with it). For PDF
 *     the guidance ("Print dialog opened. Choose Save as PDF.") replaces the progress
 *     toast just BEFORE the dialog opens: `print()` blocks until the dialog closes, so a
 *     message after it would arrive after a Save or a Cancel.
 *   - Failures stay visible (`toast.error`), worded for what happened: a lazy chunk that
 *     could not load (retried once first), a backend that could not be reached, or a
 *     conversation that is gone.
 */
import * as React from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import { useAnnouncer } from '@/soc/components/announcer';

import { getFullConversation } from '../chat-api';
import { PRINT_OPENED_MESSAGE, REPORT_EXPORT_NAME } from '../report/export/formats';
import { CHUNK_ERROR_MESSAGE, UNREACHABLE_MESSAGE, isChunkLoadError } from '../report/useReportExport';
import type { ConversationExportFormat } from './HistoryRail';

type ConversationModule = typeof import('../report/export/conversation');

/** A conversation that was deleted (or removed by the history limit) before it was read. */
export const CONVERSATION_GONE_MESSAGE = 'This conversation is no longer available.';
export const CONVERSATION_EXPORT_FAILED = 'The conversation could not be exported. Try again.';

/** The message for an export that threw. */
export function conversationExportFailure(error: unknown): string {
  if (isChunkLoadError(error)) return CHUNK_ERROR_MESSAGE;
  if (error instanceof ApiError && error.status === 0) return UNREACHABLE_MESSAGE;
  if (error instanceof ApiError && error.status === 404) return CONVERSATION_GONE_MESSAGE;
  return CONVERSATION_EXPORT_FAILED;
}

let conversationModule: Promise<ConversationModule> | null = null;

/**
 * Load the export code once (concurrent exports share the load), retrying once when the
 * chunk download fails (a network blip). A failed load is not cached: the next pick
 * tries again.
 */
function loadConversationModule(): Promise<ConversationModule> {
  if (!conversationModule) {
    conversationModule = import('../report/export/conversation').catch((first: unknown) => {
      if (!isChunkLoadError(first)) throw first;
      return import('../report/export/conversation');
    });
    conversationModule.catch(() => {
      conversationModule = null;
    });
  }
  return conversationModule;
}

/** The toast id of a conversation's export: its progress, guidance and result share it. */
const toastId = (conversationId: string) => `conversation-export-${conversationId}`;

export interface ConversationExportController {
  /** Export a conversation; ignored while an export of the same conversation runs. */
  run: (conversationId: string, format: ConversationExportFormat) => Promise<void>;
}

export function useConversationExport({ author }: { author: string | null }): ConversationExportController {
  const announce = useAnnouncer();
  // Synchronous guard: a second pick can arrive before anything renders.
  const inflight = React.useRef(new Set<string>());

  const run = React.useCallback(
    async (conversationId: string, format: ConversationExportFormat) => {
      if (inflight.current.has(conversationId)) return;
      inflight.current.add(conversationId);
      const id = toastId(conversationId);
      const preparing = `Preparing ${REPORT_EXPORT_NAME[format]}…`;
      announce(preparing);
      toast.loading(preparing, { id });
      const fail = (message: string) => {
        announce(message);
        toast.error(message, { id });
      };
      try {
        // The whole conversation, every older page included: an export is never cut to
        // the newest messages the transcript opened with.
        const [conversation, module] = await Promise.all([getFullConversation(conversationId), loadConversationModule()]);
        const outcome = await module.exportConversation(conversation, format, {
          author,
          // PDF: the guidance paints before the dialog opens (print() blocks until it closes).
          onPrintOpening: (filename: string) => {
            announce(PRINT_OPENED_MESSAGE);
            toast.success(PRINT_OPENED_MESSAGE, { id, description: `Suggested file name: ${filename}` });
          },
        });
        if (!outcome.ok) {
          fail(outcome.message);
        } else if (format === 'print') {
          // Already guided before the dialog: nothing to add once it closed.
          if (!outcome.guided) {
            announce(outcome.message);
            toast.success(outcome.message, { id, description: outcome.filename ? `Suggested file name: ${outcome.filename}` : undefined });
          }
        } else {
          announce(outcome.filename ? `${outcome.message}: ${outcome.filename}` : outcome.message);
          toast.success(outcome.message, { id, description: outcome.filename });
        }
      } catch (error) {
        fail(conversationExportFailure(error));
      } finally {
        inflight.current.delete(conversationId);
      }
    },
    [announce, author],
  );

  return React.useMemo(() => ({ run }), [run]);
}
