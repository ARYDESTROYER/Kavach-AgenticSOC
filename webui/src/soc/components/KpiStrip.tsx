/**
 * KpiStrip: the one KPI strip a page may have (Round 14, SPEC §4.9.2, operator choice C7
 * option 1). It is the Overview's strip as a shared primitive: strip tiles on a grouped
 * panel, sentence-case 13px labels, ink numerals (red only for a critical tile that
 * counts something above zero), one muted context line, no icons, and rules that only
 * ever separate two tiles. Two columns below 768px; above that the column count follows
 * the tile count on the strip's own width (`kpiStripColumns`).
 *
 * The children are `KpiTile`s (or a wrapper around one, such as a hover trend card). The
 * strip tells them its density through `KpiStripContext`, so a plain
 * `<KpiTile label value />` inside it becomes a strip tile on the panel inset without
 * repeating `variant`, `density` or `chrome` at every call site; explicit props still win.
 *
 *   <KpiStrip label="Case summary" density="comfortable">
 *     <KpiTile label="Open cases" value={fmtNumber(open)} countTo={open} context="open now" />
 *     <KpiTile label="Critical" value={fmtNumber(critical)} countTo={critical} accent="critical" />
 *   </KpiStrip>
 *
 * Use `comfortable` for the strip that heads a page (fluid numerals that grow with the
 * tile, 24 to 44px) and `compact` for a denser strip (24px numerals). A tile that filters
 * the page below is a toggle (`pressed`); a second split of the same total starts with
 * `breakBefore`.
 */
import * as React from 'react';

import { Panel } from '@/design-system/panel';
import { cn } from '@/lib/cn';

import { KpiStripContext, KpiTileGrid, type KpiStripContextValue } from './KpiTile';

export type KpiStripDensity = KpiStripContextValue['density'];

export interface KpiStripProps {
  /** The strip's accessible name (a named group), for example "Case summary". */
  label: string;
  /** `comfortable` heads a page; `compact` is a denser strip. Default `comfortable`. */
  density?: KpiStripDensity;
  /** The tiles: `KpiTile`s, or one wrapper around each. */
  children: React.ReactNode;
  /** Classes for the panel. */
  className?: string;
  /** Classes for the tile grid inside the panel. */
  gridClassName?: string;
  'data-testid'?: string;
}

/**
 * The strip: a `Panel` (no title, full bleed) holding a `KpiTileGrid` on the panel
 * surface. It names itself as a group; each tile keeps its own accessible name.
 */
export function KpiStrip({
  label,
  density = 'comfortable',
  children,
  className,
  gridClassName,
  'data-testid': testId,
}: KpiStripProps) {
  const tiles = React.Children.toArray(children).filter(Boolean);
  const context = React.useMemo<KpiStripContextValue>(() => ({ density }), [density]);
  return (
    <KpiStripContext.Provider value={context}>
      <Panel
        as="div"
        padding="none"
        role="group"
        aria-label={label}
        data-kpi-strip={density}
        data-testid={testId}
        className={cn(className)}
      >
        <KpiTileGrid count={tiles.length} surface="panel" className={gridClassName}>
          {tiles}
        </KpiTileGrid>
      </Panel>
    </KpiStripContext.Provider>
  );
}

export default KpiStrip;
