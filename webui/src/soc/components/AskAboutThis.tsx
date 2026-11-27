/**
 * AskAboutThis — the "Ask about this" action (chat revamp SPEC §10.7, A7).
 *
 * Opens a NEW chat that asks the topic's server-templated question
 * (`navigate('chat', { newChat: true, topic })`); the page resolves the id and sends the
 * question with origin `starter`, so no free text ever rides along. Shown only to a
 * caller who can use chat (`cases:read`) and only inside the app router; a standalone
 * render (tests, embeds) has neither and renders nothing.
 *
 * Lives outside the entry chunk: its hosts (KPI tiles, the Settings context line) are
 * lazy pages, and the entry's HelpTip only carries an opaque `footer` slot for it.
 */
import { MessageSquare } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { useAuth } from '@/soc/auth';
import { useRoute } from '@/soc/router';

/** `useAuth` / `useRoute` read their context before they throw, so hook order is stable. */
function useOptional<T>(hook: () => T): T | null {
  try {
    return hook();
  } catch {
    return null;
  }
}

export interface AskAboutThisProps {
  /** A `console_map` topic id (`kpi:mttr`, `settings:detection`). */
  topic: string;
  /** What the topic is, appended to the accessible name ("Ask about this: MTTR"). */
  subject?: string;
  className?: string;
}

export function AskAboutThis({ topic, subject, className }: AskAboutThisProps) {
  const auth = useOptional(useAuth);
  const route = useOptional(useRoute);
  if (!auth || !route || !auth.hasPermission('cases', 'read')) return null;
  return (
    <button
      type="button"
      onClick={() => route.navigate('chat', { newChat: true, topic })}
      aria-label={subject ? `Ask about this: ${subject}` : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline',
        focusRing,
        className,
      )}
      data-ask-topic={topic}
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      Ask about this
    </button>
  );
}

export default AskAboutThis;
