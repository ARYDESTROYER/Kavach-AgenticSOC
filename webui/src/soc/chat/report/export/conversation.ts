/**
 * "Export conversation" for the chat toolbar and history rail (chat revamp SPEC §9.3,
 * §10.1a): Markdown, HTML, PDF (print) or Word, through the SAME document model and serialisers as
 * a report — one section per exchange (the user's question, the answer prose, that
 * turn's blocks), then the deterministic Methodology & limitations built from the turns'
 * recorded steps and usage, and an appendix of the queries that ran.
 *
 * Load it lazily from the toolbar (`await import('…/report/export/conversation')`); it
 * pulls the serialisers, never the chart kit (print preloads that on demand).
 */
import { CONSOLE_RELEASE_IDENTITY } from '@/lib/release';
import type { ChatConversation } from '@/lib/types';

import { buildConversationDoc } from '../model';
import { exportDocument, type ExportOutcome } from './run';
import { reportToHtml } from './html';
import { reportToMarkdown } from './markdown';

export type ConversationExportFormat = 'markdown' | 'html' | 'print' | 'docx';

export const CONVERSATION_EXPORT_LABEL: Readonly<Record<ConversationExportFormat, string>> = {
  print: 'PDF (.pdf)',
  docx: 'Word (.docx)',
  markdown: 'Markdown (.md)',
  html: 'HTML (.html)',
};

export interface ConversationExportOptions {
  /** Defang indicators (default true). */
  defang?: boolean;
  /** The signed-in user, shown as the author. */
  author?: string | null;
  /** Export instant (tests pin it). */
  now?: Date;
  /** Print only: called just before the print dialog opens (show "Choose Save as PDF" here). */
  onPrintOpening?: (filename: string) => void;
}

/** The conversation as Markdown text (pure; for tests and Copy). */
export function conversationToMarkdown(conversation: ChatConversation, options: ConversationExportOptions = {}): string {
  const now = options.now ?? new Date();
  const doc = buildConversationDoc(conversation, {
    author: options.author ?? null,
    appVersion: CONSOLE_RELEASE_IDENTITY.version,
    generatedAt: now.toISOString(),
  });
  return reportToMarkdown(doc, { defang: options.defang !== false });
}

/** The conversation as a static HTML file (pure; for tests). */
export function conversationToHtml(conversation: ChatConversation, options: ConversationExportOptions = {}): string {
  const now = options.now ?? new Date();
  const doc = buildConversationDoc(conversation, {
    author: options.author ?? null,
    appVersion: CONSOLE_RELEASE_IDENTITY.version,
    generatedAt: now.toISOString(),
  });
  return reportToHtml(doc, { defang: options.defang !== false });
}

/**
 * Download (Markdown / HTML) or print the conversation. Resolves an outcome whose
 * `message` is ready for the shell announcer; never throws for an unavailable download.
 */
export async function exportConversation(
  conversation: ChatConversation,
  format: ConversationExportFormat,
  options: ConversationExportOptions = {},
): Promise<ExportOutcome> {
  const now = options.now ?? new Date();
  const doc = buildConversationDoc(conversation, {
    author: options.author ?? null,
    appVersion: CONSOLE_RELEASE_IDENTITY.version,
    generatedAt: now.toISOString(),
  });
  return exportDocument(doc, format, { defang: options.defang, kind: 'conversation', now, onPrintOpening: options.onPrintOpening });
}

export default exportConversation;
