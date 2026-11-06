/**
 * ModelsCatalog: the LLM model catalog table (Round 3 / Feature 9).
 *
 * Renders the GET /api/llm/models rows: provider, capability badges (context window,
 * max output, modalities, tool-json/cache support), pricing (input/output per million),
 * a provenance badge (exact/heuristic/free/default), the per-role assignment, and a
 * price-override marker. Per-row actions: open the price-override editor, and a metered
 * "test call".
 *
 * Round 14 (F9, MO1): capability chips are de-duplicated by label (a "vision" modality and
 * a "vision" capability are one "Vision" chip), and a row shows two chips then "+N" with
 * the full list in a tooltip; prices are one per cell, never wrapped mid-phrase, so a row
 * stays at most three lines tall; every label is 12px or larger (F13).
 *
 * #9: every model id / label / capability / modality is operator-/registry-influenceable
 * and is rendered as PLAIN text or in a Badge (controlled label) — never HTML. The test
 * reply + any error are shown in a fenced CodeBlock by the parent page.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Pencil, FlaskConical, Sparkles } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { DASH, fmtMoney, fmtTokens, humanizeToken } from '@/lib/format';
import {
  PRICING_SOURCE_META,
  batchRates,
  providerLabel,
  type ModelCatalogRow,
} from '@/soc/pages/Models.api';

export interface ModelsCatalogProps {
  rows: ModelCatalogRow[];
  loading?: boolean;
  /** Open the per-model price-override editor. */
  onEditPrice?: (row: ModelCatalogRow) => void;
  /** Run a metered test call against the model (feedback is shown in the test dialog). */
  onTest?: (row: ModelCatalogRow) => void;
  /** Optional provider filter — only rows whose provider matches are shown. */
  providerFilter?: string;
  /** Whether the current user may manage models (drives action availability). */
  canManage?: boolean;
  /** `panel` when the table sits in a `Panel` and bleeds to its edges. Default `bordered`. */
  surface?: 'bordered' | 'panel';
}

/** How many capability chips a row shows before the rest collapse into "+N". */
export const VISIBLE_CAPABILITY_CHIPS = 2;

/**
 * Capability chips derived from a catalog row (controlled labels, never raw text),
 * de-duplicated by label: the first chip with a label wins, so a modality and a
 * capability flag that read the same ("Vision") show once.
 */
export function capabilityChips(row: ModelCatalogRow): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  if (row.context_window > 0) {
    chips.push({ key: 'ctx', label: `${fmtTokens(row.context_window)} ctx` });
  }
  if (row.max_output > 0) {
    chips.push({ key: 'out', label: `${fmtTokens(row.max_output)} out` });
  }
  for (const m of row.modalities) {
    chips.push({ key: `mod:${m}`, label: humanizeToken(m) });
  }
  // Surface the well-known capability flags as readable chips.
  const caps = new Set(row.capabilities.map((c) => c.toLowerCase()));
  if (caps.has('tools') || caps.has('tool_use') || caps.has('tool_json') || caps.has('function_calling')) {
    chips.push({ key: 'tools', label: 'Tool JSON' });
  }
  if (
    caps.has('cache') ||
    caps.has('prompt_caching') ||
    row.cache_read_per_million != null ||
    row.cache_write_per_million != null
  ) {
    chips.push({ key: 'cache', label: 'Cache' });
  }
  if (caps.has('vision')) chips.push({ key: 'vision', label: 'Vision' });
  if (caps.has('reasoning')) chips.push({ key: 'reasoning', label: 'Reasoning' });
  const seen = new Set<string>();
  return chips.filter((chip) => {
    const label = chip.label.toLowerCase();
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

/** The capabilities cell: two chips, then "+N" with the whole list in a tooltip. */
function CapabilityChips({ row }: { row: ModelCatalogRow }) {
  const chips = capabilityChips(row);
  if (!chips.length) {
    return <span className="text-sm text-muted-foreground">{DASH}</span>;
  }
  const visible = chips.slice(0, VISIBLE_CAPABILITY_CHIPS);
  const hidden = chips.slice(VISIBLE_CAPABILITY_CHIPS);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((c) => (
        <Badge key={c.key} variant="secondary" className="whitespace-nowrap text-xs">
          {c.label}
        </Badge>
      ))}
      {hidden.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              // Starts with the visible "+N" so speech input can name it (WCAG 2.5.3).
              aria-label={`+${hidden.length} more capabilities: ${hidden.map((c) => c.label).join(', ')}`}
              data-testid="capability-more"
            >
              <Badge variant="secondary" className="cursor-default whitespace-nowrap text-xs">
                +{hidden.length}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span>{chips.map((c) => c.label).join(', ')}</span>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** One price: a muted name and the figure, never wrapped. */
function Price({
  name,
  value,
  muted,
  title,
}: {
  name: string;
  value: number | null | undefined;
  muted?: boolean;
  title?: string;
}) {
  return (
    <span
      className={cn('whitespace-nowrap', muted ? 'text-xs text-muted-foreground' : 'text-sm text-foreground')}
      title={title}
      data-price=""
    >
      <span className="text-muted-foreground">{name}</span> {fmtMoney(value)}
    </span>
  );
}

/**
 * The full per-1M pricing breakdown for a catalog row: the list input/output rate, the
 * optional prompt-cache write/read rates, and the derived batch (async) input/output
 * rate. All values go through `fmtMoney` (dash-guarded) and render as plain text (#9);
 * cache/batch lines are omitted entirely when the model has no such rate.
 */
function PricingCell({ row }: { row: ModelCatalogRow }) {
  const batch = batchRates(row);
  const batchNote = batch ? `Batch is ${Math.round(batch.multiplier * 100)}% of the list price` : undefined;
  const hasCache =
    row.cache_write_per_million != null || row.cache_read_per_million != null;
  // Two price columns (input-side, output-side), one price per cell: list, then
  // cache, then batch. A missing cache side leaves its cell empty, not a dash.
  return (
    <div className="ml-auto grid w-max grid-cols-[auto_auto] items-baseline justify-items-end gap-x-4 gap-y-0.5 tabular-nums">
      <Price name="In" value={row.input_per_million} />
      <Price name="Out" value={row.output_per_million} />
      {hasCache ? (
        <>
          {row.cache_write_per_million != null ? (
            <Price name="Cache write" value={row.cache_write_per_million} muted />
          ) : (
            <span />
          )}
          {row.cache_read_per_million != null ? (
            <Price name="Cache read" value={row.cache_read_per_million} muted />
          ) : (
            <span />
          )}
        </>
      ) : null}
      {batch ? (
        <>
          <Price name="Batch in" value={batch.input} muted title={batchNote} />
          <Price name="Batch out" value={batch.output} muted title={batchNote} />
        </>
      ) : null}
    </div>
  );
}

function ProvenanceBadge({ source }: { source: string }) {
  const meta = PRICING_SOURCE_META[source] ?? PRICING_SOURCE_META.default;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Badge variant={meta.variant} className="cursor-default">
            {meta.label}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span>Pricing provenance: {source}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function ModelsCatalog({
  rows,
  loading,
  onEditPrice,
  onTest,
  providerFilter,
  canManage = true,
  surface = 'bordered',
}: ModelsCatalogProps) {
  const filtered = React.useMemo(
    () =>
      providerFilter && providerFilter !== 'all'
        ? rows.filter((r) => r.provider === providerFilter)
        : rows,
    [rows, providerFilter],
  );

  const columns: DataTableColumn<ModelCatalogRow>[] = [
    {
      id: 'model',
      header: 'Model',
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{r.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
        </div>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      cell: (r) => <Badge variant="outline">{providerLabel(r.provider)}</Badge>,
    },
    {
      id: 'capabilities',
      header: 'Capabilities',
      cell: (r) => <CapabilityChips row={r} />,
    },
    {
      id: 'pricing',
      header: 'Price / 1M',
      align: 'right',
      cell: (r) => <PricingCell row={r} />,
    },
    {
      id: 'provenance',
      header: 'Source',
      align: 'center',
      cell: (r) => (
        <div className="flex items-center justify-center gap-1.5">
          <ProvenanceBadge source={String(r.pricing_source)} />
          {r.price_overridden ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Sparkles className="h-3.5 w-3.5 text-primary" aria-label="Operator price override" />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <span>Operator price override active</span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      id: 'assigned',
      header: 'Assigned to',
      cell: (r) =>
        r.assigned_roles.length ? (
          <div className="flex flex-wrap gap-1">
            {r.assigned_roles.map((role) => (
              <Badge key={role} variant="info" className="whitespace-nowrap text-xs">
                {humanizeToken(role)}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex items-center justify-end gap-1">
          {onTest ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onTest(r)}
              disabled={!canManage}
              aria-label={`Test ${r.id}`}
              title="Metered test call"
            >
              <FlaskConical className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          {onEditPrice ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onEditPrice(r)}
              disabled={!canManage}
              aria-label={`Override price for ${r.id}`}
              title="Override pricing"
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <DataTable<ModelCatalogRow>
      columns={columns}
      rows={filtered}
      getRowId={(r) => r.id}
      loading={loading}
      ariaLabel="LLM model catalog"
      surface={surface}
      empty={
        <span className="text-sm text-muted-foreground">No models in the catalog. Add an AI provider key.</span>
      }
    />
  );
}

export default ModelsCatalog;
