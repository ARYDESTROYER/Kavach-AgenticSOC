/**
 * The severity breakdown (Round 14, SPEC §4.7.3, operator choice C5: option A with option
 * B's "Split by"): a table block that carries a `severity` payload is drawn as a table a
 * person can act on, never as bars labelled with raw source numbers.
 *
 * - All five named levels in fixed order (Critical, High, Medium, Low, Info), zeros
 *   included. A level's label names the raw source values it holds ("High (73, 8)"), with
 *   a help tip naming each source's own scale; its badge sits on an opaque chip so it keeps
 *   its contrast on an opened (tinted) row.
 * - Columns: Severity, Events (or Cases), Share (one decimal), Trend (a sparkline over the
 *   window) and Top rules: up to three rule names that open the rule sheet, with counts,
 *   then "+7 more rules". "Split by Source" (the card's header control, shown only when the
 *   server returned more than one split) swaps that column to the top sources; "None"
 *   drops it. Switching never re-queries and never calls a model.
 * - The first cell of a level with something to list is a disclosure `<button
 *   aria-expanded>`; the opened row lists every rule the level carries, each with its count,
 *   its rule sheet and a Logs link for that rule at that level, then "+N more rules" and the
 *   level's own Logs view.
 * - Narrow cards (a phone, the Case Manager column) drop Trend and Top rules (a container
 *   query); an opened row still lists the rules.
 * - The matrix view (rules by level, option C) is offered by the card only when a rule
 *   spans two or more levels; on a phone it falls back to this table.
 *
 * Honesty (SPEC §4.7.2): the card's caption states what was sampled; the footnote says
 * levels use each source's own scale and what a share is of. Every rule, source and raw
 * value is untrusted source data (#9): plain text nodes, rule names through `RuleLink`, and
 * every link a ref the server built and `parseBlocks` validated (G2, G10).
 */
import * as React from 'react';
import { ChevronDown, ListFilter } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/ui/table';
import { HelpTip } from '@/soc/components/HelpTip';
import { SeverityBadge } from '@/soc/components/badges';
import { token } from '@/soc/components/palette';
import { severityLabel } from '@/soc/components/semantic-labels';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';

import { RefIconLink, RefLink } from '../context';
import { levelRawText, levelScaleText, sampleSentence, shareText, subjectNoun } from '../labels';
import { AnswerRuleLink } from '../rule-drill';
import type {
  InternalRef,
  SeverityBreakdown,
  SeverityKey,
  SeverityKeyCount,
  SeverityLevelData,
  SeveritySplitKey,
  TableBlock,
} from '../schema';
import { SEVERITY_SPLIT_KEYS, isRuleRef, parseInternalRef } from '../schema';
import { RowTrend } from './RowTrend';

/** What the Top column lists: rules, sources, or nothing. */
export type SeveritySplitChoice = 'none' | SeveritySplitKey;
/** The card's view of a breakdown: the levels table, or rules by level. */
export type SeverityViewChoice = 'table' | 'matrix';

/** Items a level's Top cell shows before "+N more". */
export const TOP_SHOWN = 3;
/** Below this card width Trend and Top drop (a phone, a narrow embed). */
const WIDE_COLUMNS = 'hidden @[34rem]:table-cell';
/**
 * The levels table's padding on a phone (C5 option A at 390px): 12px at the table's outer
 * edges and 16px gutters between Severity, the count and Share (8px a side), so a level's
 * badge, its raw values and its help tip stay on one line beside the counts.
 */
const PHONE_FIRST = 'max-sm:pl-3 max-sm:pr-2';
const PHONE_MIDDLE = 'max-sm:px-2';
const PHONE_LAST = 'max-sm:pl-2 max-sm:pr-3';
/**
 * The cells beside an expandable level on a phone: the row is the toggle's 44px, with the
 * badge on its centre line, so the counts move down to the same line.
 */
const PHONE_TOGGLE_ROW = 'max-sm:pt-3';
/** A phone gets the table instead of the matrix, and "Split by" in the card's ⋯ menu. */
const PHONE_QUERY = '(max-width: 639.98px)';

const SPLIT_LABEL: Readonly<Record<SeveritySplitChoice, string>> = { none: 'None', rule: 'Rule', source: 'Source' };

const fmt = (n: number) => n.toLocaleString('en-US');
const levelName = (level: SeverityKey) => severityLabel(level) ?? level;

/* -------------------------------------------------------------------------- */
/* Pure helpers (tested).                                                      */
/* -------------------------------------------------------------------------- */

/** The splits a breakdown can show, in order: rules (from its levels or a rule split), then sources. */
export function availableSplits(severity: SeverityBreakdown): SeveritySplitKey[] {
  const out: SeveritySplitKey[] = [];
  for (const key of SEVERITY_SPLIT_KEYS) {
    const fromLevels = key === 'rule' && severity.levels.some((l) => l.rules.length > 0);
    const fromSplit = Object.values(severity.splits[key] ?? {}).some((s) => s && s.top.length > 0);
    if (fromLevels || fromSplit) out.push(key);
  }
  return out;
}

/** The Top column a breakdown opens with: rules, else sources, else none. */
export function defaultSplit(severity: SeverityBreakdown): SeveritySplitChoice {
  return availableSplits(severity)[0] ?? 'none';
}

/** "Split by" appears only when the server returned more than one split (SPEC §4.7.3). */
export function splitMenuShown(severity: SeverityBreakdown): boolean {
  return Object.keys(severity.splits).length > 1;
}

/** The matrix view is offered only when a rule falls in two or more levels. */
export function matrixOffered(severity: SeverityBreakdown): boolean {
  return severity.multi_level_rules > 0 && severity.levels.some((l) => l.rules.length > 0);
}

/**
 * The Logs view of ONE rule at ONE level: the level's own Logs view (its severity, window,
 * source and the call's own filters) narrowed to the rule's exact value. Built only from
 * the two validated refs the server sent, and validated again; null when they disagree
 * (another rule, another source) or the level has no Logs view.
 */
export function ruleLevelLogsRef(level: Pick<SeverityLevelData, 'drill'>, item: Pick<SeverityKeyCount, 'drill'>): InternalRef | null {
  const base = level.drill;
  const rule = item.drill;
  if (!base || base.page !== 'logs' || !isRuleRef(rule)) return null;
  const opts = { ...(base.opts ?? {}) };
  if (opts.rule !== undefined && opts.rule !== rule.opts.rule) return null;
  if (rule.opts.sourceId && opts.sourceId && rule.opts.sourceId !== opts.sourceId) return null;
  return parseInternalRef({
    page: 'logs',
    opts: { ...opts, rule: rule.opts.rule, ...(rule.opts.sourceId ? { sourceId: rule.opts.sourceId } : {}) },
  });
}

interface TopItems {
  items: SeverityKeyCount[];
  /** "+7 more rules", "+1,240 more events from other sources", or null. */
  more: string | null;
}

/** What a level's Top cell lists for a split, and what it leaves out. */
export function topItems(
  severity: SeverityBreakdown,
  level: SeverityLevelData,
  split: SeveritySplitChoice,
  shown: number = TOP_SHOWN,
): TopItems {
  if (split === 'rule') {
    const items = level.rules.slice(0, shown);
    const rest = Math.max(0, level.rules_total - items.length);
    return { items, more: rest ? `+${fmt(rest)} more ${rest === 1 ? 'rule' : 'rules'}` : null };
  }
  if (split === 'source') {
    const entry = severity.splits.source?.[level.level];
    const items = (entry?.top ?? []).slice(0, shown);
    const rest = (entry?.top ?? []).slice(shown).reduce((sum, i) => sum + i.count, 0) + (entry?.other ?? 0);
    return {
      items,
      more: rest ? `+${fmt(rest)} more ${subjectNoun(severity.subject, rest)} from other sources` : null,
    };
  }
  return { items: [], more: null };
}

/* -------------------------------------------------------------------------- */
/* The "Split by" control (the card's header renders it).                      */
/* -------------------------------------------------------------------------- */

/** What choosing a split says to assistive tech (the Top column, or what a level lists). */
export function splitAnnouncement(next: SeveritySplitChoice): string {
  return next === 'none' ? 'Showing levels only' : next === 'source' ? 'Showing top sources' : 'Showing top rules';
}

/**
 * The "Split by" choices as menu items: None, then each split the server returned, then
 * Host, listed but disabled ("Ask again to add it"). Shared by the header control (a wide
 * card) and the card's ⋯ menu (a phone or a narrow column, where the header keeps its
 * full width for the title).
 */
export function SeveritySplitItems({
  value,
  choices,
  onChange,
}: {
  value: SeveritySplitChoice;
  choices: readonly SeveritySplitKey[];
  onChange: (next: SeveritySplitChoice) => void;
}) {
  return (
    <>
      <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as SeveritySplitChoice)}>
        <DropdownMenuRadioItem value="none">{SPLIT_LABEL.none}</DropdownMenuRadioItem>
        {choices.map((choice) => (
          <DropdownMenuRadioItem key={choice} value={choice}>
            {SPLIT_LABEL[choice]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {/* A dimension the server did not compute: asking again adds it. */}
      <DropdownMenuItem disabled className="flex-col items-start gap-0">
        <span>Host</span>
        <span className="text-2xs text-muted-foreground">Ask again to add it</span>
      </DropdownMenuItem>
    </>
  );
}

/** The header's "Split by" control on a wide card. */
export function SeveritySplitMenu({
  value,
  choices,
  onChange,
}: {
  value: SeveritySplitChoice;
  choices: readonly SeveritySplitKey[];
  onChange: (next: SeveritySplitChoice) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs font-normal" data-testid="severity-split-trigger">
          <span className="text-muted-foreground">Split by</span>
          {SPLIT_LABEL[value]}
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Splits this answer carries</DropdownMenuLabel>
        <SeveritySplitItems value={value} choices={choices} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SplitPlacementProps {
  /** A narrow column (Case Manager): the ⋯ menu, like a phone. */
  compact: boolean;
  value: SeveritySplitChoice;
  choices: readonly SeveritySplitKey[];
  onChange: (next: SeveritySplitChoice) => void;
}

/**
 * "Split by" in the card's header, on a wide card only. On a phone or in a narrow column
 * the header keeps its width for the title and caption, and {@link SeveritySplitMenuGroup}
 * offers the same choices in the ⋯ menu (operator choice C5, option A at 390 px).
 */
export function SeveritySplitHeader({ compact, ...menu }: SplitPlacementProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  if (compact || phone) return null;
  return (
    <div className="mr-1">
      <SeveritySplitMenu {...menu} />
    </div>
  );
}

/** "Split by" in the card's ⋯ menu, on a phone or in a narrow column (see {@link SeveritySplitHeader}). */
export function SeveritySplitMenuGroup({ compact, ...menu }: SplitPlacementProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  if (!compact && !phone) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-2xs uppercase tracking-wide text-muted-foreground">Split by</DropdownMenuLabel>
      <SeveritySplitItems {...menu} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces.                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The level's badge with its raw values, on an opaque chip. On a phone a level with more
 * raw values than its line can hold wraps them inside the chip (its help tip stays beside
 * it) rather than widening the table past the card.
 */
function LevelBadge({ level }: { level: SeverityLevelData }) {
  const raws = levelRawText(level);
  return (
    <span className="inline-flex rounded-md bg-card">
      <SeverityBadge
        severity={level.level}
        labelSuffix={raws ? `(${raws})` : undefined}
        className="px-1.5 py-0 text-2xs max-sm:whitespace-normal"
      />
    </span>
  );
}

/** A small icon link to a Logs (or Cases) view, named (and tooltipped) for what it opens. */
function ViewLink({ target, label }: { target: InternalRef; label: string }) {
  return <RefIconLink refValue={target} label={label} icon={<ListFilter aria-hidden />} />;
}

/**
 * A rule or source name in a list: a 24px tall line box (16px text and 4px above and
 * below), so a rule link's hit and focus box is at least 24px tall and as wide as its text,
 * and names stacked one under another sit 24px apart (WCAG 2.2 SC 2.5.8).
 */
const LIST_NAME = 'inline-block py-1 break-words';

/** One rule or source name: a rule opens its sheet; a source is plain text. */
function ItemName({ item, split, className }: { item: SeverityKeyCount; split: SeveritySplitKey; className?: string }) {
  if (split === 'rule' && isRuleRef(item.drill)) {
    return (
      <AnswerRuleLink target={item.drill} className={cn('text-xs', className)}>
        {item.key}
      </AnswerRuleLink>
    );
  }
  return (
    <span className={cn('min-w-0 break-words text-xs text-foreground', split === 'rule' && 'font-mono', className)}>{item.key}</span>
  );
}

function TopCell({ severity, level, split }: { severity: SeverityBreakdown; level: SeverityLevelData; split: SeveritySplitKey }) {
  const { items, more } = topItems(severity, level, split);
  if (!items.length) return <span className="text-sm text-muted-foreground">None</span>;
  return (
    <ul className="flex min-w-0 flex-col" aria-label={`${levelName(level.level)} top ${split === 'rule' ? 'rules' : 'sources'}`}>
      {items.map((item, i) => (
        <li key={`${item.key}-${i}`} className="flex min-w-0 items-baseline justify-between gap-2">
          <ItemName item={item} split={split} className={cn('min-w-0', LIST_NAME)} />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmt(item.count)}</span>
        </li>
      ))}
      {more ? <li className="text-xs text-muted-foreground">{more}</li> : null}
    </ul>
  );
}

/** The opened level: every rule (or source) it carries, then the level's own view. */
function LevelPanel({
  id,
  severity,
  level,
  split,
}: {
  id: string;
  severity: SeverityBreakdown;
  level: SeverityLevelData;
  split: SeverityContentSplit;
}) {
  const name = levelName(level.level);
  const noun = subjectNoun(severity.subject, 2);
  const sources = split === 'source' ? severity.splits.source?.[level.level] : undefined;
  const items = split === 'source' ? sources?.top ?? [] : level.rules;
  const rest = split === 'source' ? sources?.other ?? 0 : Math.max(0, level.rules_total - level.rules.length);
  const levelView = level.drill;
  return (
    <div id={id} className="space-y-1.5" data-testid="severity-level-panel">
      {items.length ? (
        <ul className="space-y-0.5" aria-label={`${name} ${split === 'source' ? 'sources' : 'rules'}`}>
          {items.map((item, i) => {
            const logs = split === 'source' ? (item.drill && !isRuleRef(item.drill) ? item.drill : null) : ruleLevelLogsRef(level, item);
            return (
              <li key={`${item.key}-${i}`} className="flex min-w-0 items-center gap-2 text-sm">
                {/* The wrapper takes the row's spare width; the name stays as wide as its
                    text, so its hit and focus box is the visible link (SPEC §3.3). */}
                <span className="min-w-0 flex-1">
                  <ItemName item={item} split={split} className={LIST_NAME} />
                </span>
                <span className="shrink-0 text-xs tabular-nums text-foreground">{fmt(item.count)}</span>
                {logs ? (
                  <ViewLink target={logs} label={`Open in Logs: ${item.key}, ${name}`} />
                ) : (
                  <span className="size-11 shrink-0 sm:size-8" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {split === 'source' ? 'No source names in these events.' : `No rule names in these ${noun}.`}
        </p>
      )}
      {rest || levelView ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {rest ? (
            <span>
              {split === 'source'
                ? `Other sources: ${fmt(rest)} ${subjectNoun(severity.subject, rest)}`
                : `+${fmt(rest)} more ${rest === 1 ? 'rule' : 'rules'}`}
            </span>
          ) : null}
          {levelView ? (
            <RefLink refValue={levelView} className="text-xs">
              {levelView.page === 'cases' ? `Open ${name} cases` : `Open ${name} ${noun} in Logs`}
            </RefLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What opening a level shows, for its disclosure's name: its rules (or sources) when it
 * lists any, else only the link to the level's own view, so the name never promises a list
 * the panel does not hold ("Low (10), show the link to its Logs view").
 */
export function levelToggleSuffix(
  level: Pick<SeverityLevelData, 'drill'>,
  panelItems: number,
  listing: SeveritySplitKey,
): string {
  if (panelItems > 0) return `, list its ${listing === 'source' ? 'sources' : 'rules'}`;
  if (level.drill) return level.drill.page === 'cases' ? ', show the link to its cases' : ', show the link to its Logs view';
  return ', show details';
}

/** An opened level lists rules unless the Top column shows sources. */
type SeverityContentSplit = SeveritySplitKey;

/* -------------------------------------------------------------------------- */
/* The table (option A).                                                       */
/* -------------------------------------------------------------------------- */

function LevelsTable({
  severity,
  title,
  split,
  note,
}: {
  severity: SeverityBreakdown;
  title: string;
  split: SeveritySplitChoice;
  note?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState<SeverityKey | null>(null);
  const rawId = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
  const noun = severity.subject === 'cases' ? 'Cases' : 'Events';
  const hasTrend = severity.levels.some((l) => l.trend && l.trend.length > 0);
  const top = split !== 'none';
  const listing: SeverityContentSplit = split === 'source' ? 'source' : 'rule';
  const columns = 3 + (hasTrend ? 1 : 0) + (top ? 1 : 0);
  const topHead = split === 'source' ? 'Top sources' : 'Top rules';
  return (
    <div className="min-w-0 space-y-2">
      {note}
      <div className="overflow-hidden rounded-md border border-border/70">
        <Table aria-label={title} className="text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead density="compact" scope="col" className={PHONE_FIRST}>
                Severity
              </TableHead>
              <TableHead density="compact" scope="col" className={cn('text-right', PHONE_MIDDLE)}>
                {noun}
              </TableHead>
              <TableHead density="compact" scope="col" className={cn('text-right', PHONE_LAST)}>
                Share
              </TableHead>
              {hasTrend ? (
                <TableHead density="compact" scope="col" className={WIDE_COLUMNS}>
                  Trend
                </TableHead>
              ) : null}
              {top ? (
                <TableHead density="compact" scope="col" className={WIDE_COLUMNS}>
                  {topHead}
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {severity.levels.map((level) => {
              const name = levelName(level.level);
              const scale = levelScaleText(level);
              const panelItems = listing === 'source' ? severity.splits.source?.[level.level]?.top.length ?? 0 : level.rules.length;
              const expandable = level.count > 0 && (panelItems > 0 || Boolean(level.drill));
              const isOpen = expandable && open === level.level;
              const panelId = `sev-${rawId}-${level.level}`;
              const empty = level.count === 0;
              const lift = expandable ? PHONE_TOGGLE_ROW : undefined;
              return (
                <React.Fragment key={level.level}>
                  <TableRow className={cn(isOpen && 'border-b-0 bg-accent/40 hover:bg-accent/40')} data-level={level.level}>
                    <TableCell density="compact" className={cn('align-top', PHONE_FIRST)}>
                      {/* One line: the help tip never wraps away from its badge (a long
                          raw-value list wraps inside the chip instead, see LevelBadge). */}
                      <span className="flex items-center gap-1">
                        {expandable ? (
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? panelId : undefined}
                            onClick={() => setOpen((cur) => (cur === level.level ? null : level.level))}
                            // 24px tall at least; 44px on a phone, where Trend and Top
                            // are hidden and this is the only way to a level's rules. The
                            // negative margins hand the extra height back to the cell
                            // padding: the row keeps its height (36px, 44px on a phone, which
                            // the toggle spans) and the counts stay level with the badge.
                            className={cn(
                              'inline-flex min-h-6 items-center gap-1 rounded-sm text-left -my-0.5 max-sm:-my-2 max-sm:min-h-11',
                              focusRing,
                            )}
                            data-testid="severity-level-toggle"
                          >
                            <ChevronDown
                              className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none', isOpen && 'rotate-180')}
                              aria-hidden
                            />
                            <LevelBadge level={level} />
                            <span className="sr-only">{levelToggleSuffix(level, panelItems, listing)}</span>
                          </button>
                        ) : (
                          <span className="inline-flex items-center pl-5">
                            <LevelBadge level={level} />
                          </span>
                        )}
                        {scale ? (
                          <HelpTip
                            label={`What ${name} means here`}
                            text={`Raw values: ${scale}. Each source's own scale is applied first, then the Console's one ladder names the level.`}
                            className="-my-1"
                          />
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell
                      density="compact"
                      numeric
                      className={cn(
                        'text-right align-top',
                        PHONE_MIDDLE,
                        lift,
                        empty ? 'text-muted-foreground' : 'font-medium text-foreground',
                      )}
                    >
                      {fmt(level.count)}
                    </TableCell>
                    <TableCell density="compact" numeric className={cn('text-right align-top text-muted-foreground', PHONE_LAST, lift)}>
                      {shareText(level.share)}
                    </TableCell>
                    {hasTrend ? (
                      <TableCell density="compact" className={cn(WIDE_COLUMNS, 'align-top', lift)}>
                        {level.trend && !empty ? <RowTrend points={level.trend} tone={level.level} /> : <span className="sr-only">No trend</span>}
                      </TableCell>
                    ) : null}
                    {top ? (
                      <TableCell density="compact" className={cn(WIDE_COLUMNS, 'min-w-0 align-top', lift)}>
                        <TopCell severity={severity} level={level} split={split} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                  {isOpen ? (
                    <TableRow className="bg-accent/20 hover:bg-accent/20">
                      <TableCell density="compact" colSpan={columns} className="px-4 pb-3 max-sm:px-3">
                        <LevelPanel id={panelId} severity={severity} level={level} split={listing} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The matrix (option C, offered only when a rule spans levels).               */
/* -------------------------------------------------------------------------- */

interface MatrixRow {
  id: string;
  item: SeverityKeyCount;
  byLevel: Partial<Record<SeverityKey, { count: number; logs: InternalRef | null }>>;
  total: number;
  levels: number;
}

/** The rules of every level as rows by level; a rule in two or more levels first. */
export function matrixRows(severity: SeverityBreakdown): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const level of severity.levels) {
    for (const item of level.rules) {
      const id = isRuleRef(item.drill) ? `rule:${item.drill.opts.rule}` : `key:${item.key}`;
      const row = rows.get(id) ?? { id, item, byLevel: {}, total: 0, levels: 0 };
      if (!row.byLevel[level.level]) row.levels += 1;
      const prior = row.byLevel[level.level]?.count ?? 0;
      row.byLevel[level.level] = { count: prior + item.count, logs: ruleLevelLogsRef(level, item) };
      row.total += item.count;
      rows.set(id, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => Number(b.levels > 1) - Number(a.levels > 1) || b.total - a.total || a.item.key.localeCompare(b.item.key),
  );
}

function SeverityMatrix({ severity, title }: { severity: SeverityBreakdown; title: string }) {
  const rows = matrixRows(severity);
  const spanning = rows.filter((r) => r.levels > 1).length;
  // Counts are links only where the server gave a level a Logs view (never for cases).
  const linked = rows.some((r) => Object.values(r.byLevel).some((c) => c?.logs));
  const max = Math.max(1, ...rows.flatMap((r) => Object.values(r.byLevel).map((c) => c?.count ?? 0)));
  const noun = subjectNoun(severity.subject, 2);
  return (
    <div className="min-w-0 space-y-2" data-testid="severity-matrix">
      <p className="text-xs text-muted-foreground">
        Shown as a matrix because {fmt(spanning)} {spanning === 1 ? 'rule falls' : 'rules fall'} in two or more levels.
      </p>
      <div className="overflow-x-auto rounded-md border border-border/70">
        <Table aria-label={`${title}, rules by level`} unwrapped className="text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead density="compact" scope="col">
                Rule
              </TableHead>
              {severity.levels.map((level) => (
                <TableHead key={level.level} density="compact" scope="col" className="text-center">
                  <SeverityBadge severity={level.level} icon={false} className="px-1.5 py-0 text-2xs" />
                </TableHead>
              ))}
              <TableHead density="compact" scope="col" className="text-right">
                Total
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className={cn(row.levels > 1 && 'bg-accent/30')}>
                <TableCell density="compact" className="max-w-[18rem]">
                  <ItemName item={row.item} split="rule" className="break-words" />
                  {row.levels > 1 ? <span className="block text-2xs text-muted-foreground">In {row.levels} levels</span> : null}
                </TableCell>
                {severity.levels.map((level) => {
                  const cell = row.byLevel[level.level];
                  const name = levelName(level.level);
                  // A sequential tint for a count (never a severity hue): darker is more.
                  const tint = cell?.count ? { backgroundColor: token('primary', 0.1 + 0.4 * (cell.count / max)) } : undefined;
                  return (
                    <TableCell key={level.level} density="compact" numeric className="text-center" style={tint}>
                      {cell?.count ? (
                        cell.logs ? (
                          <RefLink
                            refValue={cell.logs}
                            aria-label={`Open in Logs: ${row.item.key}, ${name}, ${fmt(cell.count)} ${subjectNoun(severity.subject, cell.count)}`}
                            className="font-medium text-foreground"
                          >
                            {fmt(cell.count)}
                          </RefLink>
                        ) : (
                          <span className="font-medium text-foreground">{fmt(cell.count)}</span>
                        )
                      ) : (
                        <span className="sr-only">None</span>
                      )}
                    </TableCell>
                  );
                })}
                <TableCell density="compact" numeric className="text-right text-foreground">
                  {fmt(row.total)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell density="compact" className="font-semibold">
                All {noun}
              </TableCell>
              {severity.levels.map((level) => (
                <TableCell key={level.level} density="compact" numeric className="text-center font-semibold">
                  {fmt(level.count)}
                </TableCell>
              ))}
              <TableCell density="compact" numeric className="text-right font-semibold">
                {fmt(severity.levels.reduce((sum, l) => sum + l.count, 0))}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="severity-matrix-note">
        {linked ? `Each count opens those ${noun} in Logs. ` : null}Darker means more; the colour is not a severity.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The view.                                                                   */
/* -------------------------------------------------------------------------- */

export interface SeverityBreakdownViewProps {
  block: TableBlock & { severity: SeverityBreakdown };
  title: string;
  /** What the Top column lists (the card's "Split by"). */
  split: SeveritySplitChoice;
  /** The card's view: the levels table or the rules-by-level matrix. */
  view?: SeverityViewChoice;
}

/** The footnote: how levels are named, what a share is of, and any sampling the caption does not state. */
export function severityFootnote(severity: SeverityBreakdown, caption: string | undefined): string {
  const parts: string[] = [];
  if (severity.subject === 'events') {
    const raws = severity.levels.some((l) => l.raw_values.length > 0);
    parts.push(raws ? "Levels use each source's own scale; the raw value is in brackets." : "Levels use each source's own scale.");
  }
  const sentence = sampleSentence(severity.sample, severity.subject);
  // The server states its own basis in the caption ("200 of at least 10,000 events
  // sampled, …"); restating it here could only disagree with it.
  const stated = /\b(sampled|counted)\b/.test(caption ?? '');
  if (sentence && !stated) parts.push(`${sentence}.`);
  const counted = severity.levels.reduce((sum, l) => sum + l.count, 0);
  if (severity.sample && sentence) {
    parts.push(`Share is of the ${fmt(counted)} ${subjectNoun(severity.subject, counted)} counted.`);
  }
  return parts.join(' ');
}

export function SeverityBreakdownView({ block, title, split, view = 'table' }: SeverityBreakdownViewProps) {
  const severity = block.severity;
  const phone = useMediaQuery(PHONE_QUERY);
  const footnote = severityFootnote(severity, block.caption);
  const matrix = view === 'matrix' && matrixOffered(severity);
  return (
    <div className="@container min-w-0" data-testid="severity-breakdown" data-subject={severity.subject}>
      {matrix && !phone ? (
        <SeverityMatrix severity={severity} title={title} />
      ) : (
        <LevelsTable
          severity={severity}
          title={title}
          split={split}
          note={
            matrix ? (
              <p className="text-xs text-muted-foreground">On a phone the matrix shows as levels; open a level to see its rules.</p>
            ) : undefined
          }
        />
      )}
      {footnote ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="severity-footnote">
          {footnote}
        </p>
      ) : null}
    </div>
  );
}

export default SeverityBreakdownView;
