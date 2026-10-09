/**
 * SourcesDisclosure — what an answer cites, behind the meta row's "Sources n"
 * (chat revamp SPEC §3.5, §10.3).
 *
 * Citations: a Help Center section opens the validated same-origin `/docs/…` link in a
 * new tab; a case opens Case Manager by its validated id; an ATT&CK technique and a
 * knowledge or query source are text. Untrusted titles are mono text and never links
 * (G7). Console links come from `console_map` (never model text): an allowed one
 * navigates, a disallowed one is plain text naming the grant it needs.
 *
 * DOM ids are index-based (`<domId>-src-<i>`), never a response string (G2), so an
 * answer's `[D1]` marker can scroll to and focus its entry.
 */
import * as React from 'react';
import { ArrowUpRight, Lock } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { ChatCitation, ConsoleLink, NavOpts } from '@/lib/types';
import type { PageId } from '@/soc/registry';
import { useNavigateOptional } from '@/soc/router';
import { isDocLink } from '../display';

/** The DOM id of citation `index`'s entry (the `[D1]` marker scrolls here). */
export function sourceEntryId(domId: string, index: number): string {
  return `${domId}-src-${index}`;
}

const KIND_LABEL: Record<ChatCitation['kind'], string> = {
  doc: 'Help Center',
  case: 'Case',
  knowledge: 'Knowledge',
  mitre: 'ATT&CK',
  query: 'Query',
};

function CitationTitle({ citation, onOpenCase }: { citation: ChatCitation; onOpenCase: (caseId: string) => void }) {
  if (citation.kind === 'doc' && citation.doc && isDocLink(citation.doc) && !citation.untrusted) {
    return (
      <a
        href={citation.doc}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {citation.title}
        <span className="sr-only"> (opens the Help Center in a new tab)</span>
      </a>
    );
  }
  if (citation.kind === 'case' && citation.case_id) {
    const caseId = citation.case_id;
    return (
      <>
        <button
          type="button"
          onClick={() => onOpenCase(caseId)}
          className="rounded-sm font-mono font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {caseId}
        </button>{' '}
        <span className={cn('text-foreground', citation.untrusted && 'font-mono')}>{citation.title}</span>
      </>
    );
  }
  return (
    <span className={cn('text-foreground', citation.untrusted && 'font-mono')}>
      {citation.kind === 'mitre' && citation.technique ? <span className="font-mono">{citation.technique} </span> : null}
      {citation.title}
    </span>
  );
}

export interface SourcesDisclosureProps {
  id: string;
  /** Prefix for entry ids (see {@link sourceEntryId}). */
  domId: string;
  citations: readonly ChatCitation[];
  consoleLinks: readonly ConsoleLink[];
  hidden?: boolean;
}

export function SourcesDisclosure({ id, domId, citations, consoleLinks, hidden = false }: SourcesDisclosureProps) {
  const navigate = useNavigateOptional();
  const openCase = React.useCallback((caseId: string) => navigate('case_manager', { caseId }), [navigate]);
  return (
    <div id={id} hidden={hidden} className="rounded-md border border-border bg-surface/40 px-3 py-2">
      {citations.length ? (
        <ol className="space-y-1.5 text-xs" aria-label="Cited sources">
          {citations.map((citation, index) => (
            <li
              key={`${citation.id}-${index}`}
              id={sourceEntryId(domId, index)}
              tabIndex={-1}
              className="flex min-w-0 scroll-mt-16 gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="w-7 shrink-0 font-mono text-2xs text-muted-foreground">{citation.id}</span>
              <span className="min-w-0 flex-1 break-words leading-relaxed">
                <span className="text-muted-foreground">{KIND_LABEL[citation.kind]} · </span>
                <CitationTitle citation={citation} onOpenCase={openCase} />
                {citation.snippet ? <span className="block text-muted-foreground">{citation.snippet}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {consoleLinks.length ? (
        <div className={cn(citations.length && 'mt-2 border-t border-border pt-2')}>
          <p className="mb-1 text-2xs text-muted-foreground">In this console</p>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Console destinations">
            {consoleLinks.map((link) => (
              <li key={link.id} className="min-w-0">
                {link.allowed ? (
                  <button
                    type="button"
                    onClick={() => navigate(link.page as PageId, (link.opts ?? {}) as NavOpts)}
                    className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {link.label}
                    <ArrowUpRight className="size-3" aria-hidden />
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Lock className="size-3" aria-hidden />
                    {link.label}
                    {link.requires ? <span> · needs {link.requires}</span> : <span> · not available to you</span>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
