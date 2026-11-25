/**
 * The AI assessment's findings (Round 16 SPEC §4.3 WP01 stub; WP14 adds "More" and
 * "Cites N events", which calls `onShowEvents` with the finding's event ids).
 *
 * The stub body is today's findings list from `InvestigationPanel.tsx` (the first
 * sentence of each finding, a Found or Clear badge, and the query in an `InlineCode`
 * fence), so mounting it in place of the inline list changes nothing. Renders nothing
 * when there is no finding. Every summary and query is UNTRUSTED model or source text:
 * plain text only (#9).
 */
import type * as React from 'react';
import type { Evidence } from '@/lib/types';
import { Badge } from '@/ui/badge';
import { InlineCode } from '@/soc/components/CodeBlock';

export interface FindingsListProps {
  findings: readonly Evidence[];
  onShowEvents?: (eventIds: string[]) => void;
}

/** A finding the agent recorded as clean (a ruled-out check), not a positive finding. */
const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

/** The first sentence of a longer text. */
function firstSentence(text?: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim();
}

export const FindingsList: React.FC<FindingsListProps> = ({ findings }) => {
  if (!findings.length) return null;
  return (
    <div className="space-y-2" data-testid="investigation-findings">
      <h3 className="text-xs font-medium text-muted-foreground">Findings</h3>
      <ul className="divide-y divide-border/60">
        {findings.map((finding, index) => {
          const clear = RULED_OUT_RE.test(finding.summary || '');
          return (
            <li key={`${finding.summary}-${index}`} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
              <Badge variant={clear ? 'success' : 'high'} className="mt-0.5 shrink-0">
                {clear ? 'Clear' : 'Found'}
              </Badge>
              <div className="min-w-0 flex-1 space-y-1">
                {/* UNTRUSTED summary: plain text. */}
                <p className="text-sm text-foreground/90">
                  {finding.summary ? firstSentence(finding.summary) : `Finding ${index + 1}`}
                </p>
                {finding.query ? (
                  /* UNTRUSTED query: inside an InlineCode fence. */
                  <InlineCode className="block w-fit max-w-full break-all text-xs">{finding.query}</InlineCode>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
