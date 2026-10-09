/**
 * `entity` block (BLOCKS.md `entity`): one bounded indicator card — the value in
 * InlineCode with a copy control and a kind chip, `RiskGauge` (number + band word) when
 * a risk was measured, a facts list, enrichment reputation rows, counts as compact KPI
 * tiles, related cases as router links, and an "Investigate" navigation. The indicator is
 * attacker-influenced text: it is shown verbatim (never defanged in the live UI), always
 * mono, and never turned into a link (G7). Facts are mono only when the server marks
 * that fact attacker-derived; product values and provider notes are sans captions.
 */
import * as React from 'react';
import { Check, Copy, Search } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { focusRing } from '@/lib/ui-recipes';
import { Badge } from '@/ui/badge';
import { InlineCode } from '@/soc/components/CodeBlock';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { SeverityBadge, VerdictBadge } from '@/soc/components/badges';
import { SEMANTIC_ICON } from '@/soc/components/palette';
import { isPageId } from '@/soc/nav';

import { CaseHoverArm, CaseLink, RefLink } from '../context';
import { formatUtc } from '../format';
import type { EntityBlock, ReputationVerdict } from '../schema';
import { KpiGroupView } from './KpiGroupView';

const KIND_LABEL: Record<EntityBlock['entity']['kind'], string> = {
  ip: 'IP address',
  domain: 'Domain',
  url: 'URL',
  hash: 'File hash',
  host: 'Host',
  user: 'User',
  email: 'E-mail',
  process: 'Process',
};

/**
 * Reputation verdicts on the shared glyph vocabulary: malicious → the critical glyph,
 * suspicious → high, clean → the INFO glyph (not green: this is the verdict axis, where
 * "clean" is a lookup result, not a safety guarantee), unknown → muted.
 */
const REPUTATION: Record<ReputationVerdict, { label: string; icon: string; cls: string }> = {
  malicious: { label: 'Malicious', icon: 'critical', cls: 'border-critical/40 bg-critical/10 text-critical-text' },
  suspicious: { label: 'Suspicious', icon: 'high', cls: 'border-high/40 bg-high/10 text-high-text' },
  clean: { label: 'Clean', icon: 'info', cls: 'border-info/40 bg-info/10 text-info-text' },
  unknown: { label: 'Unknown', icon: 'undetermined', cls: 'border-border bg-muted/50 text-muted-foreground' },
};

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy value'}
      className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground', focusRing)}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

export function EntityView({ block, idPrefix, framed = false }: { block: EntityBlock; idPrefix: string; framed?: boolean }) {
  const rawId = React.useId();
  const valueId = `ent-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const canInvestigate = isPageId('investigate');
  return (
    // The block card already frames it; only a report leaf (no card of its own) draws
    // the entity's border, so the transcript never shows a card inside a card.
    <div
      className={cn('flex min-w-0 flex-col gap-3', framed && 'rounded-md border border-border/70 p-3')}
      data-testid="block-entity"
    >
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {/* At least 16rem before the gauge wraps below it, so the facts never squeeze. */}
        <div className="min-w-[min(100%,16rem)] flex-1 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="shrink-0 text-2xs">
                {KIND_LABEL[block.entity.kind]}
              </Badge>
              {block.verdict ? <VerdictBadge verdict={block.verdict} /> : null}
            </div>
            <div className="mt-1.5 flex min-w-0 items-start gap-1">
              <InlineCode id={valueId} className="min-w-0 text-sm">
                {block.entity.value}
              </InlineCode>
              <CopyValue value={block.entity.value} />
            </div>
            {block.first_seen || block.last_seen ? (
              <p className="mt-1 text-2xs tabular-nums text-muted-foreground">
                {block.first_seen ? `First seen ${formatUtc(block.first_seen)}` : ''}
                {block.first_seen && block.last_seen ? ' · ' : ''}
                {block.last_seen ? `Last seen ${formatUtc(block.last_seen)}` : ''}
              </p>
            ) : null}
          </div>

          {/* Facts sit beside the gauge rather than below it, so the card has no dead
              band under the indicator. */}
          {block.facts.length ? (
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              {block.facts.map((f, i) => (
                <React.Fragment key={i}>
                  <dt className="truncate text-muted-foreground" title={f.label}>
                    {f.label}
                  </dt>
                  {/* Mono only for a fact the server marked attacker-derived (G7); product
                      values ("ip", "1 of 1 answered") are prose (browser-QA D7). The
                      indicator itself is already InlineCode above. */}
                  <dd className={cn('min-w-0 break-words', f.untrusted ? 'font-mono text-xs' : 'text-foreground')}>{f.value}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}
        </div>
        {typeof block.risk === 'number' ? (
          <div className="shrink-0">
            <RiskGauge score={block.risk} size={96} label="Risk" />
          </div>
        ) : null}
      </div>

      {block.reputation.length ? (
        <div>
          <h5 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Reputation</h5>
          <ul className="divide-y divide-border/60">
            {block.reputation.map((r, i) => {
              const meta = REPUTATION[r.verdict];
              const Icon = SEMANTIC_ICON[meta.icon];
              return (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-sm">
                  <span className="min-w-0 flex-1 truncate">{r.provider}</span>
                  <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium', meta.cls)}>
                    {Icon ? <Icon className="size-3" aria-hidden /> : null}
                    {meta.label}
                  </span>
                  {typeof r.score === 'number' ? <span className="text-2xs tabular-nums text-muted-foreground">score {r.score}</span> : null}
                  {/* The provider's own note (not log-derived): plain text, never a link,
                      in the card's muted caption style rather than mono (D7). */}
                  {r.detail ? <span className="w-full break-words text-xs text-muted-foreground">{r.detail}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {block.counts.length ? <KpiGroupView items={block.counts} idPrefix={`${idPrefix}-counts`} /> : null}

      {block.related_cases.length ? (
        <div>
          <h5 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Related cases</h5>
          <CaseHoverArm>
            <ul className="space-y-1">
              {block.related_cases.map((c, i) => (
                <li key={`${c.case_id}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <CaseLink facts={c} className="min-w-0 truncate">
                    {c.title}
                  </CaseLink>
                  {c.severity ? <SeverityBadge severity={c.severity} /> : null}
                </li>
              ))}
            </ul>
          </CaseHoverArm>
        </div>
      ) : null}

      {canInvestigate ? (
        <div>
          <RefLink
            refValue={{ page: 'investigate' }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-foreground no-underline hover:bg-muted hover:no-underline"
            aria-describedby={valueId}
          >
            <Search className="size-3.5" aria-hidden />
            Investigate
          </RefLink>
        </div>
      ) : null}
    </div>
  );
}
