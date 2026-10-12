/**
 * Round 12 final review: "Export conversation" (Markdown, HTML, PDF, Word) follows the
 * same rule as the server's "Save conversation as report" (`POST
 * /api/reports/from-conversation`): a reply to a chat command (`/compact`,
 * `response.command`) is a note about the chat, not an answer. It and the command that
 * asked for it are left out, so the export never shows the note as an AI answer section
 * and the Methodology never counts it as an answer.
 */
import { describe, expect, it } from 'vitest';

import type { ChatConversation, ChatConversationMessage, TurnUsage } from '@/lib/types';

import { conversationToHtml, conversationToMarkdown } from '../export/conversation';
import { buildConversationDoc } from '../model';
import { NOW, USAGE, sampleConversation } from './fixtures';

const COMPACT_NOTE = 'Summarised 1 earlier exchange. The conversation continues from the summary.';

/** A command reply makes no model call: its recorded usage is zero. */
const ZERO_USAGE: TurnUsage = {
  ...USAGE,
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  cost: 0,
  latency_ms: 0,
  peak_prompt_tokens: 0,
};

function compactExchange(at: string): ChatConversationMessage[] {
  return [
    { id: 'msg-c1', role: 'user', content: '/compact', origin: 'command', created_at: at },
    {
      id: 'msg-c2',
      role: 'assistant',
      content: COMPACT_NOTE,
      created_at: at,
      response: { answer: COMPACT_NOTE, command: 'compact', compacted: true, usage: ZERO_USAGE, message_id: 'msg-c2' },
    },
  ];
}

/** One answer, then a `/compact` exchange (the reviewer's reproduction). */
function withCompact(): ChatConversation {
  const conversation = sampleConversation();
  conversation.messages.push(...compactExchange('2026-10-08T12:02:00Z'));
  conversation.message_count = conversation.messages.length;
  return conversation;
}

/** The server's from-conversation rule: one section per assistant reply that is not a command reply. */
function serverSectionIds(conversation: ChatConversation): string[] {
  return conversation.messages.filter((m) => m.role === 'assistant' && !m.response?.command).map((m) => m.id);
}

describe('conversation export leaves chat command replies out (like Save conversation as report)', () => {
  it('drops the /compact reply and its command prompt from the document', () => {
    const conversation = withCompact();
    const doc = buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
    expect(doc.items.map((i) => i.id)).toEqual(serverSectionIds(conversation));
    expect(doc.items.map((i) => i.title)).toEqual(['Who is failing logins against vpn-gw-2?']);
    // Never turned into an unanswered question either.
    expect(doc.items.some((i) => i.title === '/compact')).toBe(false);
    expect(doc.items.flatMap((i) => i.blocks).some((b) => 'text' in b && typeof b.text === 'string' && b.text.includes('Summarised'))).toBe(false);
  });

  it('counts only answers in the Methodology', () => {
    const doc = buildConversationDoc(withCompact(), { generatedAt: NOW.toISOString() });
    const usageLine = doc.methodology.find((l) => l.startsWith('The source answers used'));
    expect(usageLine).toBeDefined();
    expect(usageLine).toContain('across 1 answer');
    expect(usageLine).not.toContain('2 answers');
    // The same figures as the conversation without the command exchange.
    const plain = buildConversationDoc(sampleConversation(), { generatedAt: NOW.toISOString() });
    expect(doc.methodology).toEqual(plain.methodology);
  });

  it('writes no /compact section in Markdown or HTML', () => {
    const conversation = withCompact();
    const md = conversationToMarkdown(conversation, { now: NOW });
    expect(md).toContain('### 1. Who is failing logins against vpn-gw-2?');
    expect(md).not.toContain('### 2.');
    expect(md).not.toContain('/compact');
    expect(md).not.toContain('Summarised 1 earlier exchange');
    expect(md).not.toContain('No answer was saved for this question.');
    const html = conversationToHtml(conversation, { now: NOW });
    expect(html).not.toContain('/compact');
    expect(html).not.toContain('Summarised 1 earlier exchange');
  });

  it('keeps answers after the command numbered in order, including one that compacted context itself', () => {
    const conversation = withCompact();
    conversation.messages.push(
      { id: 'msg-5', role: 'user', content: 'And yesterday?', created_at: '2026-10-08T12:03:00Z' },
      {
        id: 'msg-6',
        role: 'assistant',
        content: 'Yesterday had 12 failures.',
        created_at: '2026-10-08T12:03:05Z',
        // An ANSWER that summarised earlier context is still an answer (command is null).
        response: { answer: 'Yesterday had 12 failures.', compacted: true, command: null, usage: USAGE, message_id: 'msg-6' },
      },
    );
    const doc = buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
    expect(doc.items.map((i) => i.id)).toEqual(serverSectionIds(conversation));
    expect(doc.items.map((i) => i.title)).toEqual(['Who is failing logins against vpn-gw-2?', 'And yesterday?']);
    expect(doc.methodology.find((l) => l.startsWith('The source answers used'))).toContain('across 2 answers');
    const md = conversationToMarkdown(conversation, { now: NOW });
    expect(md).toContain('### 2. And yesterday?');
    expect(md).not.toContain('### 3.');
  });

  it('still keeps an unanswered question that came before a command', () => {
    const conversation = sampleConversation();
    conversation.messages.push(
      { id: 'msg-3', role: 'user', content: 'And last week?', created_at: '2026-10-08T12:01:00Z' },
      ...compactExchange('2026-10-08T12:02:00Z'),
    );
    const doc = buildConversationDoc(conversation, { generatedAt: NOW.toISOString() });
    expect(doc.items.map((i) => i.title)).toEqual(['Who is failing logins against vpn-gw-2?', 'And last week?']);
    expect(doc.items[1].blocks.some((b) => b.type === 'callout' && b.text === 'No answer was saved for this question.')).toBe(true);
  });
});
