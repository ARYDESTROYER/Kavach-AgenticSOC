/**
 * The AI assessment's findings (Round 16 SPEC §4.5 WP14, research data-visibility R5).
 *
 * Each finding leads with its first sentence, a Found or Clear badge and the query in an
 * `InlineCode` fence. A longer finding gets "More", which shows the whole summary as
 * plain text. A finding that cites events gets "Cites N events": with `onShowEvents` it
 * opens the Evidence tab's event table narrowed to those events; without it the ids are
 * listed in `InlineCode` with Copy. Renders nothing when there is no finding.
 *
 * Every summary, query and event id is UNTRUSTED model or source text: plain text only
 * (#9).
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import type { Evidence } from '@/lib/types';
import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';

import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { InlineCode } from '@/soc/components/CodeBlock';

export interface FindingsListProps {
  findings: readonly Evidence[];
  onShowEvents?: (eventIds: string[]) => void;
}

/** A finding the agent recorded as clean (a ruled-out check), not a positive finding. */
const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

/** The first sentence of a longer text. */
export function firstSentence(text?: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim();
}

/** The distinct event ids a finding cites, in its order. */
function citedIds(finding: Evidence): string[] {
  return Array.from(new Set((finding.event_ids ?? []).map(String).filter(Boolean)));
}

const Finding: React.FC<{ finding: Evidence; index: number; onShowEvents?: (eventIds: string[]) => void }> = ({
  finding,
  index,
  onShowEvents,
}) => {
  const [more, setMore] = React.useState(false);
  const [idsOpen, setIdsOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const moreId = React.useId();
  const summary = (finding.summary || '').trim();
  const lead = summary ? firstSentence(summary) : `Finding ${index + 1}`;
  const hasMore = summary.length > lead.length;
  const ids = citedIds(finding);
  const clear = RULED_OUT_RE.test(finding.summary || '');
  const citeLabel = `Cites ${ids.length.toLocaleString('en-US')} event${ids.length === 1 ? '' : 's'}`;

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <li className="flex items-start gap-3 py-2 first:pt-0 last:pb-0" data-testid="investigation-finding">
      <Badge variant={clear ? 'success' : 'high'} className="mt-0.5 shrink-0">
        {clear ? 'Clear' : 'Found'}
      </Badge>
      <div className="min-w-0 flex-1 space-y-1">
        {/* UNTRUSTED summary: plain text. */}
        {more ? (
          <p id={moreId} className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm text-foreground/90">
            {summary}
          </p>
        ) : (
          <p className="text-sm text-foreground/90">{lead}</p>
        )}
        {finding.query ? (
          /* UNTRUSTED query: inside an InlineCode fence. */
          <InlineCode className="block w-fit max-w-full break-all text-xs">{finding.query}</InlineCode>
        ) : null}
        {hasMore || ids.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {hasMore ? (
              <button
                type="button"
                aria-expanded={more}
                aria-controls={more ? moreId : undefined}
                onClick={() => setMore((value) => !value)}
                className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDown className={cn('size-3.5 transition-transform', more && 'rotate-180')} aria-hidden />
                {more ? 'Less' : 'More'}
              </button>
            ) : null}
            {ids.length ? (
              onShowEvents ? (
                <button
                  type="button"
                  onClick={() => onShowEvents(ids)}
                  className="rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="finding-cites"
                >
                  {citeLabel}
                </button>
              ) : (
                <button
                  type="button"
                  aria-expanded={idsOpen}
                  onClick={() => setIdsOpen((value) => !value)}
                  className="rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="finding-cites"
                >
                  {citeLabel}
                </button>
              )
            ) : null}
          </div>
        ) : null}
        {!onShowEvents && idsOpen && ids.length ? (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="finding-event-ids">
            {ids.map((id) => (
              /* UNTRUSTED id: an InlineCode fence. */
              <InlineCode key={id} className="text-xs">
                {id}
              </InlineCode>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => void copyText(ids.join('\n')).then(setCopied)}
            >
              {copied ? 'Copied' : 'Copy ids'}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
};

export const FindingsList: React.FC<FindingsListProps> = ({ findings, onShowEvents }) => {
  if (!findings.length) return null;
  return (
    <div className="space-y-2" data-testid="investigation-findings">
      <h3 className="text-xs font-medium text-muted-foreground">Findings</h3>
      <ul className="divide-y divide-border/60">
        {findings.map((finding, index) => (
          <Finding key={`${finding.summary}-${index}`} finding={finding} index={index} onShowEvents={onShowEvents} />
        ))}
      </ul>
    </div>
  );
};
