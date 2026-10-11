/**
 * A chart block as a STANDALONE SVG document (Round 12 P0-8: "Download PNG / SVG"), for a
 * slide or a ticket. Pure and deterministic: the same block, options and paint give the
 * same bytes, so it is unit-tested without a layout engine.
 *
 * Why a dedicated renderer rather than serialising the live `<svg>`: the live marks use
 * `hsl(var(--x))` and Tailwind classes that mean nothing outside the page, the legend
 * and axis titles are HTML, the hbar shortcut is not an SVG at all, and the hover
 * crosshair or focus ring must never end up in a file. This module draws the SAME data
 * with the SAME geometry helpers (`geometry.ts`), the same honesty rules (a stack or a
 * donut only where the values add up — `honestChart`; `null` is hatched or breaks a
 * line, never 0) and the same labels (`format.ts`), with every colour RESOLVED through
 * `paint` to a plain `#rrggbb` (+ opacity) so the file renders anywhere, in either theme.
 *
 * The caller passes the block AS SHOWN (re-binned, zoomed, hidden series flagged), so
 * the image is what the analyst was looking at — and the image SAYS how it differs from
 * the server's answer, because on a slide or a ticket the Group by control, the zoom bar
 * and the struck-through legend entry are not there to say it: "grouped by month" joins
 * the subtitle, a zoom reads "Zoomed to <first> – <last> (n of N points)", and a hidden
 * series stays in the legend marked "(hidden)" with "Showing 1 of 2 series" (and, for a
 * stack, that each stack totals the shown series only). Every string is XML-escaped; no
 * block string ever becomes an attribute other than escaped text content (G2).
 */
import { xmlSafe } from '@/lib/xml-safe';
import { token } from '@/soc/components/palette';

import {
  DASH,
  IN_PROGRESS_SUFFIX,
  axisZone,
  clipText,
  formatTick,
  formatValue,
  hasCalendarLabels,
  instantOf,
  unitLabel,
  xTickLabel,
} from '../format';
import type { BlockProvenance, ChartBlock } from '../schema';
import { honestChart } from '../views';
import type { ChartZoomView } from './export-context';
import {
  BAR_MAX,
  areaPath,
  barWidth,
  donutArcs,
  extent,
  lineRuns,
  niceScale,
  pickXLabels,
  placeXLabels,
  reconcilingShares,
  roundedRightPath,
  roundedTopPath,
  stackSegments,
  stackTotals,
} from './geometry';
import { categoryStyles, seriesStyles, type SeriesStyle } from './series';

/** A resolved colour: a plain `#rrggbb` (or any colour the caller vouches for) and an opacity. */
export interface Paint {
  color: string;
  opacity: number;
}
/** Resolves a token colour string (`hsl(var(--chart-1))`, `hsl(var(--x) / 0.3)`) to a {@link Paint}. */
export type PaintResolver = (css: string) => Paint;

export interface ChartSvgOptions {
  title: string;
  /** The card's caption / scope line, shown under the title. */
  subtitle?: string;
  paint: PaintResolver;
  /** Logical width in px (default 960, a 16:9 slide at 1920 when rasterised at 2×). */
  width?: number;
  /** When the image was made (footer); defaults to now. */
  generatedAt?: Date;
  provenance?: BlockProvenance;
  /** `hidden[k]`: series k was hidden by its legend toggle (colours stay bound to k). */
  hidden?: readonly boolean[];
  /** The coarser unit a client-side Group by shows ("month"), else absent. */
  grouping?: string;
  /** The brush zoom the block is cut to (the block passed IS that slice), else absent. */
  zoom?: ChartZoomView | null;
}

export interface ChartSvg {
  svg: string;
  width: number;
  height: number;
}

export const EXPORT_FONT = "Inter, 'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const PAD = 24;
/** Approximate advance of one 12px glyph (export text is 12px; `geometry.CHAR_W` is 11px). */
const CHAR12 = 7.2;
const IN_PROGRESS_OPACITY = 0.6;

/**
 * XML-escape text content and attribute values. Code points XML 1.0 forbids (U+FFFE,
 * U+FFFF, C0 controls, lone surrogates) are dropped first: the display sanitiser keeps
 * U+FFFE and U+FFFF, and one of them in a log-derived label would make the saved SVG
 * malformed and the PNG fail to draw.
 */
export function esc(text: string): string {
  return xmlSafe(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

function fill(p: Paint, opacity = 1): string {
  const o = p.opacity * opacity;
  return ` fill="${esc(p.color)}"${o < 1 ? ` fill-opacity="${r2(o)}"` : ''}`;
}
function stroke(p: Paint, opacity = 1): string {
  const o = p.opacity * opacity;
  return ` stroke="${esc(p.color)}"${o < 1 ? ` stroke-opacity="${r2(o)}"` : ''}`;
}

interface TextOpts {
  size?: number;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  mono?: boolean;
  baseline?: 'middle';
}
function text(x: number, y: number, body: string, p: Paint, o: TextOpts = {}): string {
  const attrs = [
    `x="${r2(x)}"`,
    `y="${r2(y)}"`,
    `font-size="${o.size ?? 12}"`,
    o.weight ? `font-weight="${o.weight}"` : '',
    o.anchor && o.anchor !== 'start' ? `text-anchor="${o.anchor}"` : '',
    o.mono ? `font-family="${esc(MONO_FONT)}"` : '',
    o.baseline === 'middle' ? 'dy="0.35em"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<text ${attrs}${fill(p)}>${esc(body)}</text>`;
}

/** Greedy word wrap to at most `lines` lines of `maxChars`, the last one ellipsised. */
export function wrapText(value: string, maxChars: number, lines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length <= lines) return out.map((l) => clipText(l, maxChars));
  const kept = out.slice(0, lines);
  kept[lines - 1] = clipText(`${kept[lines - 1]} ${out.slice(lines).join(' ')}`, maxChars);
  return kept;
}

const PROVENANCE_WORD: Record<BlockProvenance, string> = {
  code: 'computed from your data',
  source: 'read from the source system',
  ai: 'values stated by the model, not measured',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/* -------------------------------------------------------------------------- */
/* Legend.                                                                     */
/* -------------------------------------------------------------------------- */
interface LegendItem {
  color: Paint;
  label: string;
  value?: string;
  line?: boolean;
  /** Hidden by its legend toggle: a faint swatch and "(hidden)" after the label. */
  hidden?: boolean;
}

/** The suffix a hidden series' legend entry carries. */
export const HIDDEN_SUFFIX = ' (hidden)';

/** Lay legend items out in wrapping rows from (x, y) within `maxX`; returns the SVG and its height. */
function legendRows(items: LegendItem[], x: number, y: number, maxX: number, fg: Paint, muted: Paint, mono: boolean): { svg: string; height: number } {
  if (!items.length) return { svg: '', height: 0 };
  const parts: string[] = [];
  let cx = x;
  let cy = y;
  const rowH = 20;
  for (const it of items) {
    const label = `${clipText(it.label, 36)}${it.hidden ? HIDDEN_SUFFIX : ''}`;
    const valueW = it.value ? (it.value.length + 1) * CHAR12 : 0;
    const w = 16 + label.length * CHAR12 + valueW + 18;
    if (cx > x && cx + w > maxX) {
      cx = x;
      cy += rowH;
    }
    const swatch = it.hidden ? 0.3 : 1;
    parts.push(
      it.line
        ? `<rect x="${r2(cx)}" y="${r2(cy + 6)}" width="12" height="2" rx="1"${fill(it.color, swatch)}/>`
        : `<rect x="${r2(cx)}" y="${r2(cy + 2)}" width="10" height="10" rx="2"${fill(it.color, swatch)}/>`,
    );
    parts.push(text(cx + 16, cy + 11, label, it.hidden ? muted : fg, { mono }));
    if (it.value) parts.push(text(cx + 16 + label.length * CHAR12 + 6, cy + 11, it.value, muted));
    cx += w;
  }
  return { svg: parts.join(''), height: cy - y + rowH };
}

/* -------------------------------------------------------------------------- */
/* Plots. Each returns its SVG (translated by the caller) and its height.      */
/* -------------------------------------------------------------------------- */
interface Ctx {
  W: number;
  paint: PaintResolver;
  fg: Paint;
  muted: Paint;
  border: Paint;
  bg: Paint;
  hatch: string;
  /** Indices of the series drawn (every series unless a legend toggle hid some). */
  visible: number[];
}

function hatchDef(ctx: Ctx): string {
  return (
    `<pattern id="${ctx.hatch}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<line x1="0" y1="0" x2="0" y2="6" stroke-width="1.5"${stroke(ctx.muted, 0.3)}/></pattern>`
  );
}

function cartesian(block: ChartBlock, ctx: Ctx, styles: SeriesStyle[]): { svg: string; height: number } {
  const kind = block.kind === 'sparkline' ? 'bar' : block.kind;
  const isLine = kind === 'line' || kind === 'area';
  const stacked = kind === 'stacked_bar';
  const n = block.x.values.length;
  const unit = block.unit;
  const visible = ctx.visible;
  const values = visible.map((k) => block.series[k].values);
  const totals = stacked ? stackTotals(values, n) : null;
  const [lo, hi] = stacked ? extent([totals ?? []]) : extent(values);
  const refY = block.reference?.axis === 'y' ? block.reference.value : null;
  const integer = (unit === 'count' || unit === 'tokens' || unit === 'bytes') && values.every((vs) => vs.every((v) => v === null || Number.isInteger(v)));
  const scale = niceScale(Math.min(lo, refY ?? lo), Math.max(hi, refY ?? hi), 5, integer);
  const ticks = scale.ticks.map((t) => formatTick(t, unit));
  const plotH = 300;
  const xAxisH = block.last_in_progress ? 38 : 24;
  const top = 8;
  const baseline = top + plotH - xAxisH;
  const x0 = PAD + Math.ceil(Math.max(...ticks.map((t) => t.length)) * CHAR12) + 8;
  const plotW = Math.max(1, ctx.W - PAD - x0);
  const slot = plotW / Math.max(1, n);
  const yOf = (v: number) => baseline - ((v - scale.min) / (scale.max - scale.min)) * (baseline - top);
  const xOf = (i: number) => x0 + (i + 0.5) * slot;
  const zeroY = yOf(0);
  const last = n - 1;
  const op = (i: number) => (block.last_in_progress && i === last ? IN_PROGRESS_OPACITY : 1);
  const catStyles = kind === 'bar' ? categoryStyles(block, false) : null;
  const out: string[] = [];

  scale.ticks.forEach((t, q) => {
    if (t !== 0) out.push(`<rect x="${r2(x0)}" y="${r2(Math.round(yOf(t)))}" width="${r2(plotW)}" height="1"${fill(ctx.border)}/>`);
    out.push(text(x0 - 8, yOf(t), ticks[q], ctx.muted, { anchor: 'end', baseline: 'middle' }));
  });

  if (!isLine) {
    const m = Math.max(1, visible.length);
    const gap = 2;
    const groupW = stacked || m === 1 ? barWidth(slot, BAR_MAX + 10) : Math.min((slot * 2) / 3, m * (BAR_MAX + 10) + (m - 1) * gap);
    const memberW = stacked || m === 1 ? groupW : Math.max(1, (groupW - (m - 1) * gap) / m);
    for (let i = 0; i < n; i += 1) {
      const left = xOf(i) - groupW / 2;
      if (stacked) {
        const segs = stackSegments(
          block.series.map((s) => s.values[i] ?? null),
          zeroY,
          (baseline - top) / (scale.max - scale.min),
          block.series.map((_, k) => visible.includes(k)),
        );
        if (segs === null) {
          out.push(`<rect x="${r2(x0 + i * slot + 1)}" y="${r2(top)}" width="${r2(Math.max(1, slot - 2))}" height="${r2(zeroY - top)}" fill="url(#${ctx.hatch})"/>`);
          continue;
        }
        for (const seg of segs) {
          const p = ctx.paint(styles[seg.series].color);
          out.push(
            seg.top
              ? `<path d="${roundedTopPath(r2(left), seg.y, r2(groupW), seg.h)}"${fill(p, op(i))}/>`
              : `<rect x="${r2(left)}" y="${seg.y}" width="${r2(groupW)}" height="${seg.h}"${fill(p, op(i))}/>`,
          );
        }
        continue;
      }
      visible.forEach((k, member) => {
        const v = block.series[k].values[i];
        const x = left + member * (memberW + gap);
        if (!isNum(v)) {
          out.push(`<rect x="${r2(x)}" y="${r2(top)}" width="${r2(Math.max(1, memberW))}" height="${r2(zeroY - top)}" fill="url(#${ctx.hatch})"/>`);
          return;
        }
        if (v === 0) return;
        const p = ctx.paint(catStyles ? catStyles[i].color : styles[k].color);
        const yTop = v > 0 ? Math.min(yOf(v), zeroY - 2) : zeroY;
        const h = v > 0 ? zeroY - yTop : Math.max(2, yOf(v) - zeroY);
        out.push(
          v > 0
            ? `<path d="${roundedTopPath(r2(x), r2(yTop), r2(memberW), r2(h))}"${fill(p, op(i))}/>`
            : `<rect x="${r2(x)}" y="${r2(yTop)}" width="${r2(memberW)}" height="${r2(h)}"${fill(p, op(i))}/>`,
        );
      });
    }
  } else {
    visible.forEach((k) => {
      const s = block.series[k];
      const p = ctx.paint(styles[k].color);
      const solid = block.last_in_progress && n > 1 ? s.values.slice(0, n - 1) : s.values;
      for (const run of lineRuns(solid, xOf, yOf)) {
        if (kind === 'area' && run.indices.length > 1) out.push(`<path d="${areaPath(run, s.values, xOf, yOf, zeroY)}"${fill(p, 0.12)}/>`);
        if (run.indices.length > 1) {
          out.push(`<path d="${run.path}" fill="none" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"${stroke(p)}/>`);
        } else {
          const i = run.indices[0];
          out.push(`<circle cx="${r2(xOf(i))}" cy="${r2(yOf(s.values[i] as number))}" r="3"${fill(p)}/>`);
        }
      }
      const a = s.values[n - 2];
      const b = s.values[n - 1];
      if (block.last_in_progress && n > 1 && isNum(a) && isNum(b)) {
        out.push(
          `<path d="M${r2(xOf(n - 2))},${r2(yOf(a))}L${r2(xOf(n - 1))},${r2(yOf(b))}" fill="none" stroke-width="2.5" stroke-dasharray="4 4"${stroke(p)}/>`,
        );
      }
    });
  }

  out.push(`<rect x="${r2(x0)}" y="${r2(Math.round(zeroY))}" width="${r2(plotW)}" height="1"${fill(ctx.muted, 0.6)}/>`);
  if (block.reference?.axis === 'y') {
    const y = Math.round(yOf(block.reference.value));
    out.push(`<rect x="${r2(x0)}" y="${y}" width="${r2(plotW)}" height="1"${fill(ctx.muted, 0.8)}/>`);
    out.push(text(x0 + plotW, y - 5, block.reference.label, ctx.muted, { anchor: 'end' }));
  }

  const isTime = block.x.kind === 'time';
  const short = block.x.values.map((_, i) => xTickLabel(block.x, i, 14));
  const instants = isTime && !hasCalendarLabels(block.x) ? block.x.values.map((v) => instantOf(v)) : undefined;
  const picks = placeXLabels(pickXLabels(short, plotW * 0.92, instants), short, xOf, ctx.W - PAD);
  const mono = block.untrusted && !isTime;
  for (const l of picks) out.push(text(l.x, baseline + 17, l.text, ctx.muted, { anchor: 'middle', mono }));
  if (block.last_in_progress && n > 0) {
    const label = IN_PROGRESS_SUFFIX.trim();
    const w = label.length * CHAR12;
    const cx = Math.min(xOf(last), ctx.W - PAD - w / 2);
    out.push(text(cx, baseline + 32, label, ctx.muted, { anchor: 'middle', size: 11 }));
  }
  return { svg: out.join(''), height: top + plotH };
}

function hbar(block: ChartBlock, ctx: Ctx, styles: SeriesStyle[]): { svg: string; height: number } {
  const n = block.x.values.length;
  const visible = ctx.visible;
  const m = Math.max(1, visible.length);
  const rowH = m > 1 ? Math.max(30, m * 10 + 12) : 30;
  const barH = m > 1 ? Math.max(5, Math.floor((rowH - 12 - (m - 1)) / m)) : 16;
  const unit = block.unit;
  const [lo, hi] = extent(visible.map((k) => block.series[k].values));
  const scale = niceScale(lo, hi, 5);
  const valueTexts = visible.flatMap((k) => block.series[k].values.map((v) => formatValue(v, unit)));
  const valueW = Math.ceil(Math.max(3, ...valueTexts.map((t) => t.length)) * CHAR12) + 10;
  const labelW = Math.min(260, Math.round(ctx.W * 0.3));
  const x0 = PAD + labelW + 10;
  const plotW = Math.max(1, ctx.W - PAD - x0 - valueW);
  const xOf = (v: number) => x0 + ((v - scale.min) / (scale.max - scale.min)) * plotW;
  const zeroX = xOf(0);
  const catStyles = categoryStyles(block, false);
  const mono = block.untrusted;
  const labelChars = Math.max(4, Math.floor(labelW / CHAR12));
  const out: string[] = [];
  const top = 4;
  for (const t of scale.ticks) {
    if (t !== 0) out.push(`<rect x="${r2(Math.round(xOf(t)))}" y="${top}" width="1" height="${n * rowH}"${fill(ctx.border)}/>`);
    out.push(text(xOf(t), top + n * rowH + 15, formatTick(t, unit), ctx.muted, { anchor: 'middle' }));
  }
  out.push(`<rect x="${r2(Math.round(zeroX))}" y="${top}" width="1" height="${n * rowH}"${fill(ctx.muted, 0.6)}/>`);
  for (let i = 0; i < n; i += 1) {
    const rowTop = top + i * rowH;
    const groupTop = rowTop + (rowH - (m * barH + (m - 1))) / 2;
    out.push(text(PAD + labelW, rowTop + rowH / 2, clipText(block.x.values[i] ?? '', labelChars), ctx.fg, { anchor: 'end', baseline: 'middle', mono }));
    visible.forEach((k, member) => {
      const v = block.series[k].values[i];
      const y = Math.round(groupTop + member * (barH + 1));
      if (!isNum(v)) {
        out.push(`<rect x="${r2(x0)}" y="${y}" width="${r2(plotW)}" height="${barH}" fill="url(#${ctx.hatch})"/>`);
        return;
      }
      const p = ctx.paint(catStyles ? catStyles[i].color : styles[k].color);
      if (v !== 0) {
        const w = Math.max(2, Math.abs(xOf(v) - zeroX));
        out.push(
          v > 0
            ? `<path d="${roundedRightPath(r2(zeroX), y, r2(w), barH)}"${fill(p)}/>`
            : `<rect x="${r2(zeroX - w)}" y="${y}" width="${r2(w)}" height="${barH}"${fill(p)}/>`,
        );
      }
      out.push(text(Math.max(zeroX, xOf(v)) + 5, y + barH / 2, formatValue(v, unit), ctx.fg, { baseline: 'middle', weight: 500 }));
    });
  }
  return { svg: out.join(''), height: top + n * rowH + 22 };
}

function donut(block: ChartBlock, ctx: Ctx): { svg: string; height: number; legend: LegendItem[] } {
  const values = block.series[0]?.values ?? [];
  const styles = categoryStyles(block, true) ?? [];
  const measured = values.every(isNum);
  const total = measured ? (values as number[]).reduce((a, b) => a + Math.max(0, b), 0) : null;
  const shares = total !== null ? reconcilingShares(values as number[], total) : null;
  const size = 240;
  const c = size / 2;
  const outer = c - 2;
  const inner = Math.round(outer * 0.62);
  const out: string[] = [];
  for (const arc of donutArcs(values, PAD + c, 8 + c, outer, inner)) {
    out.push(`<path d="${arc.path}" fill-rule="evenodd"${fill(ctx.paint(styles[arc.index]?.color ?? token('chart-8')))}/>`);
  }
  if (total !== null) {
    out.push(text(PAD + c, 8 + c - 4, formatValue(total, block.unit), ctx.fg, { anchor: 'middle', size: 22, weight: 600 }));
    out.push(text(PAD + c, 8 + c + 18, 'Total', ctx.muted, { anchor: 'middle' }));
  }
  const legend: LegendItem[] = block.x.values.map((label, i) => ({
    color: ctx.paint(styles[i]?.color ?? token('chart-8')),
    label,
    value: `${formatValue(values[i] ?? null, block.unit)}${shares ? ` · ${shares[i]}%` : ''}`,
  }));
  return { svg: out.join(''), height: size + 16, legend };
}

function funnel(block: ChartBlock, ctx: Ctx, styles: SeriesStyle[]): { svg: string; height: number } {
  const values = block.series[0]?.values ?? [];
  const n = block.x.values.length;
  const rowH = 34;
  const max = Math.max(1, ...values.filter(isNum));
  const labelW = Math.min(260, Math.round(ctx.W * 0.3));
  const x0 = PAD + labelW + 10;
  const plotW = Math.max(1, ctx.W - PAD - x0 - 220);
  const p = ctx.paint(styles[0]?.color ?? token('chart-1'));
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = 4 + i * rowH;
    const v = values[i];
    out.push(text(PAD + labelW, y + 11, clipText(block.x.values[i] ?? '', Math.floor(labelW / CHAR12)), ctx.fg, { anchor: 'end', baseline: 'middle', mono: block.untrusted }));
    if (!isNum(v)) {
      out.push(`<rect x="${r2(x0)}" y="${y + 2}" width="${r2(plotW)}" height="18" fill="url(#${ctx.hatch})"/>`);
      out.push(text(x0 + plotW + 8, y + 11, DASH, ctx.muted, { baseline: 'middle' }));
      continue;
    }
    const w = Math.max(2, (Math.max(0, v) / max) * plotW);
    out.push(`<path d="${roundedRightPath(r2(x0), y + 2, r2(w), 18)}"${fill(p)}/>`);
    let note = formatValue(v, block.unit);
    const prev = i > 0 ? values[i - 1] : null;
    if (isNum(prev) && prev > 0) {
      // A stage larger than the one above is not a reduction (FunnelChart says the same).
      const ratio = Math.round((v / prev) * 100);
      note += ratio > 100 ? `  ·  +${ratio - 100}% vs the stage above (not a reduction)` : `  ·  ${ratio}% of the stage above`;
    }
    out.push(text(x0 + w + 8, y + 11, note, ctx.fg, { baseline: 'middle', weight: 500 }));
  }
  return { svg: out.join(''), height: 4 + n * rowH };
}

/**
 * What the image must say about the view it shows (pure; exported for tests): a zoom
 * ("Zoomed to Jul 2026 – Oct 2026 (4 of 12 points)") and hidden series ("Showing 1 of 2
 * series", and for a stack that each stack totals the shown series only).
 */
export function viewNotes(block: ChartBlock, visible: readonly number[], zoom: ChartZoomView | null): string[] {
  const notes: string[] = [];
  if (zoom) notes.push(`Zoomed to ${zoom.first} – ${zoom.last} (${zoom.shown} of ${zoom.total} points)`);
  const total = block.series.length;
  if (block.kind !== 'donut' && total >= 2 && visible.length < total) {
    notes.push(`Showing ${visible.length} of ${total} series${block.kind === 'stacked_bar' ? ', so each stack totals the shown series only' : ''}`);
  }
  return notes;
}

/**
 * The chart as an SVG document: title, subtitle (caption, grouping, unit and the time
 * zone of a time axis), the view notes (zoom, hidden series), legend, plot and a footer
 * (provenance and when the image was made).
 */
export function chartSvg(raw: ChartBlock, options: ChartSvgOptions): ChartSvg {
  const block = honestChart(raw);
  const W = Math.max(480, Math.round(options.width ?? 960));
  const paint = options.paint;
  const ctx: Ctx = {
    W,
    paint,
    fg: paint(token('foreground')),
    muted: paint(token('muted-foreground')),
    border: paint(token('border')),
    bg: paint(token('background')),
    hatch: 'agentic-soc-hatch',
    visible: block.series.map((_, k) => k).filter((k) => options.hidden?.[k] !== true),
  };
  // At least one series is always drawn (the legend never hides the last one).
  if (!ctx.visible.length) ctx.visible = block.series.map((_, k) => k);
  const body: string[] = [];
  let y = PAD;

  for (const line of wrapText(options.title || 'Chart', Math.floor((W - 2 * PAD) / 10.5), 2)) {
    y += 22;
    body.push(text(PAD, y, line, ctx.fg, { size: 18, weight: 600 }));
  }
  const sub: string[] = [];
  if (options.subtitle) sub.push(options.subtitle);
  if (options.grouping) sub.push(`grouped by ${options.grouping}`);
  // The unit, unless it is a plain count (the title already says what is counted).
  if (block.unit !== 'count') sub.push(unitLabel(block.unit));
  if (block.x.kind === 'time') sub.push(`times in ${axisZone(block.x)}`);
  for (const line of wrapText(sub.join(' · '), Math.floor((W - 2 * PAD) / 7.4), 2)) {
    y += 19;
    body.push(text(PAD, y, line, ctx.muted, { size: 13 }));
  }
  // How this view differs from the whole answer, in the foreground ink: a reader of the
  // image cannot see the zoom bar or the legend toggles that say it on screen.
  for (const line of wrapText(viewNotes(block, ctx.visible, options.zoom ?? null).join(' · '), Math.floor((W - 2 * PAD) / 7.2), 2)) {
    y += 18;
    body.push(text(PAD, y, line, ctx.fg, { size: 12, weight: 500 }));
  }
  y += 14;

  const styles = seriesStyles(block);
  let plot: { svg: string; height: number };
  let legend: LegendItem[] = [];
  if (block.kind === 'donut') {
    const d = donut(block, ctx);
    plot = d;
    legend = d.legend;
  } else if (block.kind === 'hbar') {
    plot = hbar(block, ctx, styles);
  } else if (block.kind === 'funnel') {
    plot = funnel(block, ctx, styles);
  } else {
    plot = cartesian(block, ctx, styles);
  }
  // A multi-series chart names every series: a hidden one stays, marked "(hidden)".
  if (block.kind !== 'donut' && block.series.length >= 2) {
    const line = block.kind === 'line' || block.kind === 'area';
    legend = block.series.map((_, k) => ({ color: paint(styles[k].color), label: styles[k].label, line, hidden: !ctx.visible.includes(k) }));
  }

  if (block.kind === 'donut') {
    // The legend is the direct label: beside the ring.
    body.push(`<g transform="translate(0,${r2(y)})">${plot.svg}</g>`);
    const lx = PAD + 240 + 32;
    const rows = legend.map((it, i) => {
      const ly = y + 24 + i * 26;
      return (
        `<rect x="${lx}" y="${r2(ly - 10)}" width="12" height="12" rx="2"${fill(it.color)}/>` +
        text(lx + 20, ly, clipText(it.label, 40), ctx.fg, { mono: block.untrusted }) +
        text(W - PAD, ly, it.value ?? '', ctx.fg, { anchor: 'end', weight: 500 })
      );
    });
    body.push(rows.join(''));
    y += Math.max(plot.height, legend.length * 26 + 16);
  } else {
    if (legend.length) {
      const l = legendRows(legend, PAD, y, W - PAD, ctx.fg, ctx.muted, false);
      body.push(`<g>${l.svg}</g>`);
      y += l.height + 8;
    }
    body.push(`<g transform="translate(0,${r2(y)})">${plot.svg}</g>`);
    y += plot.height;
  }

  y += 22;
  const footer = [`Agentic SOC, ${PROVENANCE_WORD[options.provenance ?? block.provenance]}`, utcStamp(options.generatedAt ?? new Date())];
  if (block.truncated) footer.push('not every item is shown');
  body.push(text(PAD, y, footer.join(' · '), ctx.muted, { size: 11 }));
  y += PAD - 6;

  const H = Math.ceil(y);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(EXPORT_FONT)}">` +
    `<title>${esc(options.title || 'Chart')}</title>` +
    `<defs>${hatchDef(ctx)}</defs>` +
    `<rect width="${W}" height="${H}"${fill(ctx.bg)}/>` +
    body.join('') +
    '</svg>';
  return { svg, width: W, height: H };
}
