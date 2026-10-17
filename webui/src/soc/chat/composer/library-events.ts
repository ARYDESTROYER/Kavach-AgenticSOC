/**
 * Prompt-library requests from outside the composer (the new-chat start screen), on
 * window events, so the lazily loaded chat pieces need no prop channel between them
 * (the `report-sync` pattern). The Workspace composer listens; nothing else does.
 *
 * Round 13 (SPEC-chat §3.9, §5.2, §7.1):
 * - {@link openPromptLibrary} takes optional `categories`: a category pill opens the
 *   library filtered to them (the composer passes them to `PromptLibraryDialog`).
 * - {@link pickPromptFromLibrary} runs one prompt id through exactly the path the
 *   library's **Use** takes (fill the composer, open its values card, or start the
 *   promptbook runner): a `use_prompt` starter card. The text is the analyst's own, so
 *   it is sent later with `origin: 'user'`. (SPEC-chat §7.1 calls this
 *   `usePromptFromLibrary`; a `use`-prefixed name is reserved for React hooks and fails
 *   `react-hooks/rules-of-hooks` when called from a click handler.)
 *
 * Event details are untrusted input (any script on the page can dispatch them): the
 * `on…` helpers keep only known categories and a well-formed prompt id, and drop the
 * event otherwise. Dispatchers are safe outside a browser.
 */
import type { ChatPromptCategory } from '@/lib/types';
import { isPromptCategory } from './prompt-library';

export const OPEN_PROMPT_LIBRARY_EVENT = 'agentic-soc:open-prompt-library';
export const PICK_LIBRARY_PROMPT_EVENT = 'agentic-soc:pick-library-prompt';

/** `UserPrefs.chat_prompts[].id` (backend `CHAT_PROMPT_ID_PATTERN`) or a library starter id. */
const PROMPT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** What {@link openPromptLibrary} asks for. No categories (or none known): the whole library. */
export interface OpenPromptLibraryDetail {
  categories?: readonly ChatPromptCategory[];
}

/** What {@link pickPromptFromLibrary} asks for. */
export interface PickLibraryPromptDetail {
  promptId: string;
}

export type OpenPromptLibraryListener = (detail: OpenPromptLibraryDetail) => void;
export type PickLibraryPromptListener = (detail: PickLibraryPromptDetail) => void;

function canDispatch(): boolean {
  return typeof window !== 'undefined' && typeof CustomEvent === 'function';
}

/** Known categories only, deduplicated, in the given order; `undefined` when none remain. */
function cleanCategories(value: unknown): ChatPromptCategory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ChatPromptCategory[] = [];
  for (const item of value) {
    if (isPromptCategory(item) && !out.includes(item)) out.push(item);
  }
  return out.length ? out : undefined;
}

/** Ask the Workspace composer to open its prompt library, optionally filtered to `categories`. */
export function openPromptLibrary(options: OpenPromptLibraryDetail = {}): void {
  if (!canDispatch()) return;
  const categories = cleanCategories(options.categories);
  const detail: OpenPromptLibraryDetail = categories ? { categories } : {};
  window.dispatchEvent(new CustomEvent<OpenPromptLibraryDetail>(OPEN_PROMPT_LIBRARY_EVENT, { detail }));
}

/** Listen for {@link openPromptLibrary}; returns the unsubscribe function. */
export function onOpenPromptLibrary(listener: OpenPromptLibraryListener): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const raw = (event as CustomEvent<unknown>).detail;
    const categories = cleanCategories(raw && typeof raw === 'object' ? (raw as { categories?: unknown }).categories : undefined);
    listener(categories ? { categories } : {});
  };
  window.addEventListener(OPEN_PROMPT_LIBRARY_EVENT, handler);
  return () => window.removeEventListener(OPEN_PROMPT_LIBRARY_EVENT, handler);
}

/**
 * Ask the Workspace composer to use the saved (or library) prompt `promptId`, exactly as
 * the library's **Use** does. A malformed id dispatches nothing; an id the composer cannot
 * find is the listener's to report.
 */
export function pickPromptFromLibrary(promptId: string): void {
  if (!canDispatch() || typeof promptId !== 'string' || !PROMPT_ID_RE.test(promptId)) return;
  window.dispatchEvent(
    new CustomEvent<PickLibraryPromptDetail>(PICK_LIBRARY_PROMPT_EVENT, { detail: { promptId } }),
  );
}

/** Listen for {@link pickPromptFromLibrary}; returns the unsubscribe function. */
export function onPickPromptFromLibrary(listener: PickLibraryPromptListener): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const raw = (event as CustomEvent<unknown>).detail;
    const promptId = raw && typeof raw === 'object' ? (raw as { promptId?: unknown }).promptId : undefined;
    if (typeof promptId !== 'string' || !PROMPT_ID_RE.test(promptId)) return;
    listener({ promptId });
  };
  window.addEventListener(PICK_LIBRARY_PROMPT_EVENT, handler);
  return () => window.removeEventListener(PICK_LIBRARY_PROMPT_EVENT, handler);
}
