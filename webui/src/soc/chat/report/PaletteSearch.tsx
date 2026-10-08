/**
 * The command palette's chat entries (chat revamp SPEC §10.4a): "Search chats" and
 * "Open Reports", plus the chat search results themselves (saved conversations matching
 * the term — the server's `?q=` content search, with the matched snippet — and reports
 * whose title matches). The palette renders this group LAST, so it never takes the
 * default Enter from a page or action the query names.
 *
 * "Ask AI: <text>" is not offered yet: nothing reads a palette question on the chat page
 * (`NavOpts` has no `ask`, and the page only resolves `topic` ids), so the entry would
 * open an empty chat and drop the analyst's words. It returns with its consumer.
 *
 * Loaded LAZILY by the always-on palette (`React.lazy`), so this module never reaches the
 * entry chunk (SPEC §10.10's +1 kB budget), and the chat data client loads only when the
 * operator actually searches. "Search chats" is opt-in: the palette never sends a
 * conversation search per keystroke until it is chosen. Every title and snippet is plain
 * text (cmdk renders children as text; #9).
 */
import * as React from 'react';
import { FileText, MessageSquare, Search } from 'lucide-react';

import type { ChatConversationSearchHit, NavOpts, ReportListEntry } from '@/lib/types';
import { CommandGroup, CommandItem } from '@/ui/command';
import { useAuth } from '@/soc/auth';
import type { PageId } from '@/soc/nav';

/** The palette's own jump helper (records a recent target, navigates, closes). */
export type PaletteGo = (page: PageId, label: string, opts?: NavOpts) => void;

export interface PaletteSearchProps {
  /** The palette's raw query. */
  query: string;
  go: PaletteGo;
}

const DEBOUNCE_MS = 180;
const MAX_CHATS = 8;
const MAX_REPORTS = 5;

export default function PaletteSearch({ query, go }: PaletteSearchProps) {
  const { hasPermission } = useAuth();
  const [searching, setSearching] = React.useState(false);
  const [chats, setChats] = React.useState<ChatConversationSearchHit[]>([]);
  const [reports, setReports] = React.useState<ReportListEntry[]>([]);
  const term = query.trim();
  const q = term.toLowerCase();

  React.useEffect(() => {
    if (!searching || term.length < 2) {
      setChats([]);
      setReports([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void import('../chat-api').then(({ listConversations, listReports }) =>
        Promise.allSettled([
          listConversations({ q: term, limit: MAX_CHATS }, controller.signal),
          listReports(controller.signal),
        ]).then(([c, r]) => {
          if (controller.signal.aborted) return;
          setChats(c.status === 'fulfilled' ? c.value.conversations.slice(0, MAX_CHATS) : []);
          setReports(
            r.status === 'fulfilled'
              ? r.value.filter((x) => x.title.toLowerCase().includes(term.toLowerCase())).slice(0, MAX_REPORTS)
              : [],
          );
        }),
      );
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [searching, term]);

  // The chat and report routes need cases:read (SPEC §6.1, §9.2).
  if (!hasPermission('cases', 'read')) return null;
  const matches = (words: string) => !q || words.includes(q);
  // The rail's "Reports" page already answers a query that names it (its palette target
  // matches "page reports"); "Open Reports" covers the blank state and other wording.
  const navReportsShown = !!q && 'page reports'.includes(q);

  return (
    <>
      <CommandGroup heading="Chat">
        {!searching && (term || matches('search chats conversations history')) ? (
          <CommandItem value="action-search-chats" onSelect={() => setSearching(true)}>
            <Search aria-hidden />
            <span className="truncate">{term ? `Search chats for “${term}”` : 'Search chats'}</span>
          </CommandItem>
        ) : null}
        {searching && term.length < 2 ? (
          <CommandItem value="action-search-chats-hint" disabled>
            <Search aria-hidden />
            <span>Type to search your chats and reports</span>
          </CommandItem>
        ) : null}
        {matches('open reports library') && !navReportsShown ? (
          <CommandItem value="action-open-reports" onSelect={() => go('reports', 'Reports')}>
            <FileText aria-hidden />
            <span>Open Reports</span>
          </CommandItem>
        ) : null}
      </CommandGroup>
      {chats.length ? (
        <CommandGroup heading="Chats">
          {chats.map((c) => (
            <CommandItem
              key={`chat-${c.id}`}
              value={`chat ${c.id}`}
              onSelect={() => go('chat', 'Workspace', { conversationId: c.id, messageId: c.match?.message_id ?? undefined })}
            >
              <MessageSquare aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{c.title}</span>
                {c.match?.snippet ? <span className="truncate text-xs text-muted-foreground">{c.match.snippet}</span> : null}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
      {reports.length ? (
        <CommandGroup heading="Reports">
          {reports.map((r) => (
            <CommandItem key={`report-${r.id}`} value={`report ${r.id}`} onSelect={() => go('reports', 'Reports', { reportId: r.id })}>
              <FileText aria-hidden />
              <span className="truncate">{r.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}
    </>
  );
}
