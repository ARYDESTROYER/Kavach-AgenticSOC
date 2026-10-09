/**
 * `case_list` block (BLOCKS.md `case_list`): compact rows — the case title as a router
 * link to the exact case (with a lazy `CaseHoverCard` preview once a pointer arrives),
 * its id in mono, then severity / verdict / status badges, risk and age. Titles are
 * case-store text and may carry log-derived words, so they stay plain text (G7).
 */
import { humanizeAge } from '@/lib/format';
import { RiskBadge, SeverityBadge, StatusBadge, VerdictBadge } from '@/soc/components/badges';

import { CaseHoverArm, CaseLink } from '../context';
import { formatUtc } from '../format';
import type { CaseListBlock } from '../schema';

export function CaseListView({ block }: { block: CaseListBlock }) {
  if (!block.items.length) return <p className="text-sm text-muted-foreground">No cases matched.</p>;
  return (
    <CaseHoverArm>
      <ul className="divide-y divide-border/70 rounded-md border border-border/70" data-testid="block-case-list">
        {block.items.map((it, i) => (
          <li key={`${it.case_id}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <div className="min-w-0 flex-1">
              <CaseLink facts={it} className="block truncate text-sm font-medium">
                {it.title}
              </CaseLink>
              <span className="font-mono text-2xs text-muted-foreground">{it.case_id}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {it.severity ? <SeverityBadge severity={it.severity} /> : null}
              {it.verdict ? <VerdictBadge verdict={it.verdict} /> : null}
              {it.status ? <StatusBadge status={it.status} /> : null}
              {typeof it.risk === 'number' ? <RiskBadge score={it.risk} /> : null}
              {it.created_at ? (
                <span className="whitespace-nowrap text-2xs tabular-nums text-muted-foreground" title={formatUtc(it.created_at)}>
                  {humanizeAge(it.created_at)}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </CaseHoverArm>
  );
}
