/**
 * "Open the prompt library" from outside the composer (the new-chat empty state), on one
 * window event, so the lazily loaded chat pieces need no prop channel between them (the
 * `report-sync` pattern). The Workspace composer listens; nothing else does.
 */
export const OPEN_PROMPT_LIBRARY_EVENT = 'agentic-soc:open-prompt-library';

/** Ask the Workspace composer to open its prompt library. Safe outside a browser. */
export function openPromptLibrary(): void {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(OPEN_PROMPT_LIBRARY_EVENT));
}

/** Listen for {@link openPromptLibrary}; returns the unsubscribe function. */
export function onOpenPromptLibrary(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = () => listener();
  window.addEventListener(OPEN_PROMPT_LIBRARY_EVENT, handler);
  return () => window.removeEventListener(OPEN_PROMPT_LIBRARY_EVENT, handler);
}
