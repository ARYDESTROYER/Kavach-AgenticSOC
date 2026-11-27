/**
 * `entity` block (BLOCKS.md `entity`): one bounded indicator card — the value in
 * InlineCode with a copy control and a kind chip, `RiskGauge` (number + band word) when
 * a risk was measured, a facts list, enrichment reputation rows, counts as compact KPI
 * tiles, related cases as router links, and an "Investigate" navigation. The indicator is
 * attacker-influenced text: it is shown verbatim (never defanged in the live UI), always
 * mono, and never turned into a link (G7). Facts are mono only when the server marks
 * that fact attacker-derived; product values are sans captions. A provider's reputation
 * note is a sans caption unless the block is marked untrusted (it can hold third-party
 * tags), when it stays mono. Sans text values (facts, provider names such as
 * "demo-synthetic", notes) set proportional numerals, whose hyphen is not set wide
 * (PW4-8); dates and scores keep tabular ones.
 *
 * A case's entity card (Round 14, F7, SPEC §4.6.3) names the case by its number; an
 * answer saved before that, whose Case fact holds the internal id, shows it the Case
 * Manager queue's way (middle-ellipsised, mono, muted, the whole id in its tooltip and for
 * assistive tech) as a link to the case, never the bare 32-character id. Its Status fact
 * is in the Console's words (the StatusBadge's, `display.ts` `caseStatusWord`).
 *
 * A fact that lists its values one by one (`items`, Round 14: a case card's Rules fact)
 * shows them in order, comma separated: a value with a rule ref (built by the server from
 * the exact stored value, re-validated by `parseBlocks`) is a `RuleLink` that opens the
 * rule sheet over the case's own window, "From CASE-000214" when the card names its case;
 * a value without one is plain text. The fact's `value` is display text the server joined
 * and clamped ("a, b, c…"), so it is never split into links: an answer saved before
 * Round 14 (no `items`) shows it as written, and so do print and the exports.
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

import { isSafeCaseId } from '@/soc/case-result-route';

import { CaseHoverArm, CaseLink, CaseRefText, RefLink, shortCaseId } from '../context';
import { formatUtc } from '../format';
import { caseStatusWord } from '../../display';
import { ENTITY_KIND_LABEL, REPUTATION_LABEL, entityFacts } from '../labels';
import { AnswerRuleLink } from '../rule-drill';
import type { EntityBlock, EntityFact, ReputationVerdict } from '../schema';
import { KpiGroupView } from './KpiGroupView';

/**
 * Reputation verdicts on the shared glyph vocabulary: malicious → the critical glyph,
 * suspicious → high, clean → the INFO glyph (not green: this is the verdict axis, where
 * "clean" is a lookup result, not a safety guarantee), unknown → muted.
 */
const REPUTATION: Record<ReputationVerdict, { label: string; icon: string; cls: string }> = {
  malicious: { label: REPUTATION_LABEL.malicious, icon: 'critical', cls: 'border-critical/40 bg-critical/10 text-critical-text' },
  suspicious: { label: REPUTATION_LABEL.suspicious, icon: 'high', cls: 'border-high/40 bg-high/10 text-high-text' },
  clean: { label: REPUTATION_LABEL.clean, icon: 'info', cls: 'border-info/40 bg-info/10 text-info-text' },
  unknown: { label: REPUTATION_LABEL.unknown, icon: 'undetermined', cls: 'border-border bg-muted/50 text-muted-foreground' },
};

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy value'}
      // Paper has nothing to copy with (Round 12 WP-REP rule: controls are print-hidden).
      data-print-hide=""
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

export interface EntityViewProps {
  block: EntityBlock;
  idPrefix: string;
  /** Draw the entity's own frame (a report leaf: no block card around it). */
  framed?: boolean;
  /**
   * The count tiles draw their own closed frame: nothing frames them (a bare card in a
   * report panel item, the expanded sheet). Otherwise they sit in the entity's or the
   * card's frame and hang to its content edge (KpiGroupView).
   */
  countsFramed?: boolean;
  /** Print / static export: count tiles are not buttons and their deltas take their own line. */
  staticMode?: boolean;
}

/** An internal case id (`case-95928c…`), as a stored answer's Case fact may hold it. */
const INTERNAL_CASE_ID_RE = /^case-[0-9a-f]{8,}$/i;

/**
 * The case a case card names by its number (its trusted Case fact), read after "From " in
 * a rule sheet it opens; undefined for any other card, a case named by its title (source
 * text) or a stored internal id.
 */
function caseOrigin(facts: readonly EntityFact[]): string | undefined {
  const named = facts.find((f) => f.label.trim().toLowerCase() === 'case');
  const value = named && !named.untrusted ? named.value.trim() : '';
  return value && !INTERNAL_CASE_ID_RE.test(value) ? value : undefined;
}

/**
 * A fact's values one by one, comma separated: a value with a rule ref opens its rule
 * sheet (the display-safe value as its text, the exact value in the ref), any other is
 * plain text. Print and static exports show plain text only.
 */
function FactItems({
  fact,
  items,
  origin,
  staticMode,
}: {
  fact: EntityFact;
  items: NonNullable<EntityFact['items']>;
  origin: string | undefined;
  staticMode: boolean;
}) {
  return (
    <span className={cn(fact.untrusted ? 'font-mono text-xs' : 'text-foreground proportional-nums')} data-fact-items="">
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ', ' : null}
          {item.drill && !staticMode ? (
            <AnswerRuleLink target={item.drill} origin={origin} className="text-xs">
              {item.value}
            </AnswerRuleLink>
          ) : (
            <span>{item.value}</span>
          )}
        </React.Fragment>
      ))}
    </span>
  );
}

/**
 * One fact's value. Product values are prose; a fact the server marked attacker-derived is
 * mono (G7). Two facts of a case card read better than their stored text (F7): a legacy
 * internal id in Case and a raw status key in Status. A fact with `items` lists them (see
 * {@link FactItems}); everything else, an older Rules fact included, is shown exactly as
 * written.
 */
function FactValue({ fact, origin, staticMode }: { fact: EntityFact; origin: string | undefined; staticMode: boolean }) {
  const label = fact.label.trim().toLowerCase();
  const value = fact.value;
  if (fact.items?.length) return <FactItems fact={fact} items={fact.items} origin={origin} staticMode={staticMode} />;
  if (label === 'case' && INTERNAL_CASE_ID_RE.test(value.trim()) && isSafeCaseId(value.trim())) {
    const id = value.trim();
    const short = shortCaseId(id);
    const text = (
      <span className="whitespace-nowrap font-mono text-xs text-muted-foreground" title={id} data-case-ref="id">
        <span aria-hidden>{short}</span>
        <span className="sr-only">{id}</span>
      </span>
    );
    return staticMode ? text : <CaseLink facts={{ case_id: id }}>{text}</CaseLink>;
  }
  const status = label === 'status' && !fact.untrusted ? caseStatusWord(value) : null;
  if (status) return <span className="text-foreground proportional-nums">{status}</span>;
  return <span className={cn(fact.untrusted ? 'font-mono text-xs' : 'text-foreground proportional-nums')}>{value}</span>;
}

export function EntityView({ block, idPrefix, framed = false, countsFramed = false, staticMode = false }: EntityViewProps) {
  const rawId = React.useId();
  const valueId = `ent-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const canInvestigate = isPageId('investigate');
  // The kind is the badge: a "Kind" fact restating it is not listed again (T14).
  const facts = entityFacts(block);
  const origin = caseOrigin(facts);
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
                {ENTITY_KIND_LABEL[block.entity.kind]}
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
          {facts.length ? (
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              {facts.map((f, i) => (
                <React.Fragment key={i}>
                  <dt className="truncate text-muted-foreground" title={f.label}>
                    {f.label}
                  </dt>
                  {/* Mono only for a fact the server marked attacker-derived (G7); product
                      values ("1 of 1 answered") are prose (browser-QA D7). The indicator
                      itself is already InlineCode above. */}
                  <dd className="min-w-0 break-words">
                    <FactValue fact={f} origin={origin} staticMode={staticMode} />
                  </dd>
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
                  <span className="min-w-0 flex-1 truncate proportional-nums">{r.provider}</span>
                  <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-2xs font-medium', meta.cls)}>
                    {Icon ? <Icon className="size-3" aria-hidden /> : null}
                    {meta.label}
                  </span>
                  {typeof r.score === 'number' ? <span className="text-2xs tabular-nums text-muted-foreground">score {r.score}</span> : null}
                  {/* The provider's note: plain text, never a link. It can carry the
                      provider's tags, which community feeds take from third parties, so
                      on a block marked untrusted it keeps the mono untrusted-data cue
                      (G7); otherwise it is the card's muted sans caption (D7). */}
                  {r.detail ? (
                    <span
                      className={cn(
                        'w-full break-words text-muted-foreground',
                        block.untrusted ? 'font-mono text-2xs' : 'text-xs proportional-nums',
                      )}
                    >
                      {r.detail}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {block.counts.length ? (
        <KpiGroupView items={block.counts} idPrefix={`${idPrefix}-counts`} framed={countsFramed} staticMode={staticMode} />
      ) : null}

      {block.related_cases.length ? (
        <div>
          <h5 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Related cases</h5>
          <CaseHoverArm>
            <ul className="space-y-1">
              {block.related_cases.map((c, i) => (
                <li key={`${c.case_id}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <CaseLink facts={c} className="min-w-0 break-words">
                    {/* Number then title; the internal id only as a tooltip (T14). */}
                    <CaseRefText facts={c} />
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
