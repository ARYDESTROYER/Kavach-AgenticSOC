/**
 * The chat page's side of an "Ask AI" chip (Round 12 WP-ASK; SPEC §4 WP-ASK, A7).
 *
 * A chip navigates to a new Workspace chat with a TYPED REFERENCE `{ kind, value }`
 * (`NavOpts.entity`), never free text. The page reads it with {@link chatEntityRef},
 * resolves it with {@link getChatEntityQuestion} (`POST /api/chat/entity-question`: the
 * server checks the value's shape for its kind and words the question), and sends that
 * question with `origin: "starter"`, exactly as an "Ask about this" topic question. The
 * value is log- or case-derived, so it is never analyst-authored for the indicator taint
 * rule (#9). Nothing is prefilled, so nothing the analyst did not ask for is sent as their
 * own words.
 *
 * Kept tiny and separate from the chip's module (`components/ask-ai.ts`): a module both
 * the chip chunk and the chat chunk import would become a shared chunk the entry chunk's
 * preload lists must name. The server is the authority on the grammar; this only checks
 * the reference's form before asking it.
 */
import { ApiError, request } from '@/lib/api';

/** The kinds a chip asks about (the server's `EntityAskKind`; pinned by a test). */
export const CHAT_ENTITY_KINDS = ['ip', 'host', 'user', 'hash', 'domain', 'url', 'email', 'rule', 'case'] as const;
export type ChatEntityKind = (typeof CHAT_ENTITY_KINDS)[number];

/** A typed reference from a chip. */
export interface ChatEntityRef {
  kind: ChatEntityKind;
  value: string;
}

/** The server's question for a reference. */
export interface ChatEntityQuestion extends ChatEntityRef {
  question: string;
}

/** The server's request bound for a value. */
const MAX_VALUE = 512;
/** No control, format, private-use, unassigned or separator characters. */
const SAFE = /^[^\p{C}\p{Z}]+$/u;

/**
 * The reference a navigation carries, or `null` when it is not one: a known kind and a
 * trimmed, bounded, single-token value (the server checks the kind's own shape).
 */
export function chatEntityRef(raw: unknown): ChatEntityRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, value } = raw as { kind?: unknown; value?: unknown };
  if (typeof kind !== 'string' || !(CHAT_ENTITY_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE || !SAFE.test(trimmed)) return null;
  return { kind: kind as ChatEntityKind, value: trimmed };
}

/** The longest question the page sends (the saved-prompt and palette bound). */
const MAX_QUESTION = 2000;

/**
 * The server-worded question for a reference (`POST` keeps log-derived values such as
 * user names out of URLs). Rejects (an `ApiError`) when the server has no question for
 * it (422), the viewer lacks the chat grant (403), or the reply is not a question the
 * page can send whole (502).
 */
export async function getChatEntityQuestion(ref: ChatEntityRef): Promise<ChatEntityQuestion> {
  const raw = await request<unknown>('POST', 'chat/entity-question', { body: { kind: ref.kind, value: ref.value } });
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const question = typeof src.question === 'string' ? src.question.trim() : '';
  // Sent verbatim as the message, so an empty, over-long or control-bearing reply is
  // refused rather than cut.
  if (!question || question.length > MAX_QUESTION || /[\p{Cc}\p{Cf}]/u.test(question)) {
    throw new ApiError(502, 'This question could not be read.', raw);
  }
  return { kind: ref.kind, value: ref.value, question };
}
