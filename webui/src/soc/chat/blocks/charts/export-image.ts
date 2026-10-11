/**
 * "Download PNG" / "Download SVG" for a chart block (Round 12 P0-8). Client-side and
 * read-only: the block's own numbers drawn by `export-svg.ts`, saved through the ONE
 * download helper (`lib/download.ts`). No dependency, no network, no model call.
 *
 * Colours are resolved in the THEME OF THE CARD: a probe element inside the card takes
 * the token colour (`hsl(var(--chart-1))`, …) and the browser's computed `color` gives
 * the concrete value — so a dark-theme chart downloads dark, a light one light, and a
 * chart inside a scope that overrides the tokens (the print root) downloads as shown.
 * The PNG is the same SVG rasterised on a canvas at 2× for a crisp slide image.
 */
import { downloadBlob, exportFileName } from '@/lib/download';

import type { ChartBlock } from '../schema';
import { chartSvg, type ChartSvgOptions, type Paint, type PaintResolver } from './export-svg';

/** Light-theme stand-ins for an environment that cannot resolve a colour (no layout engine). */
const FALLBACK: Readonly<Record<string, string>> = {
  background: '#ffffff',
  card: '#ffffff',
  foreground: '#1c2024',
  'muted-foreground': '#60646c',
  border: '#d9d9e0',
};
const SERIES_FALLBACK = '#0d74ce';

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** `rgb(…)` / `rgba(…)` / `color(srgb …)` as a {@link Paint}, else null. */
export function parseComputedColor(value: string): Paint | null {
  const v = value.trim();
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    return { color: `#${hex2(Number(m[1]))}${hex2(Number(m[2]))}${hex2(Number(m[3]))}`, opacity: Number.isFinite(a) ? a : 1 };
  }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    return {
      color: `#${hex2(Number(m[1]) * 255)}${hex2(Number(m[2]) * 255)}${hex2(Number(m[3]) * 255)}`,
      opacity: Number.isFinite(a) ? a : 1,
    };
  }
  return null;
}

const TOKEN_RE = /var\(--([a-z0-9-]+)\)(?:\s*\/\s*([\d.]+))?/i;

function fallbackPaint(css: string): Paint {
  const m = TOKEN_RE.exec(css);
  const alpha = m?.[2] !== undefined ? Number(m[2]) : 1;
  return { color: (m && FALLBACK[m[1]]) || SERIES_FALLBACK, opacity: Number.isFinite(alpha) ? alpha : 1 };
}

/**
 * A resolver that reads each token colour as the card shows it. The probe lives inside
 * `host` for the duration of one export (call `dispose`), so it inherits the card's theme.
 */
export function paintResolver(host: Element | null): PaintResolver & { dispose: () => void } {
  const cache = new Map<string, Paint>();
  let probe: HTMLElement | null = null;
  if (host && typeof document !== 'undefined' && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    host.appendChild(probe);
  }
  const resolve = ((css: string): Paint => {
    const hit = cache.get(css);
    if (hit) return hit;
    let out: Paint | null = null;
    if (probe) {
      probe.style.color = '';
      probe.style.color = css;
      out = parseComputedColor(window.getComputedStyle(probe).color);
    }
    const paint = out ?? fallbackPaint(css);
    cache.set(css, paint);
    return paint;
  }) as PaintResolver & { dispose: () => void };
  resolve.dispose = () => {
    probe?.remove();
    probe = null;
  };
  return resolve;
}

export interface ChartImageRequest {
  block: ChartBlock;
  title: string;
  subtitle?: string;
  /** Series hidden by a legend toggle (colours stay bound to their index). */
  hidden?: readonly boolean[];
  /** The element whose theme the image takes (the block card). */
  host: Element | null;
}

function render(req: ChartImageRequest, extra: Partial<ChartSvgOptions> = {}) {
  const paint = paintResolver(req.host);
  try {
    return chartSvg(req.block, { title: req.title, subtitle: req.subtitle, hidden: req.hidden, paint, ...extra });
  } finally {
    paint.dispose();
  }
}

/** The chart as a standalone SVG document (exported for tests and the SVG download). */
export function chartSvgDocument(req: ChartImageRequest): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(req).svg}`;
}

/** Save the chart as an `.svg` file. Returns whether a download started. */
export function downloadChartSvg(req: ChartImageRequest): boolean {
  return downloadBlob(exportFileName('chart', req.title, 'svg'), new Blob([chartSvgDocument(req)], { type: 'image/svg+xml;charset=utf-8' }));
}

/** How long a rasterisation may take before it is given up (ms). */
export const RASTER_TIMEOUT_MS = 10_000;

/**
 * Draw an SVG document on a canvas at `scale` and return the PNG, or null where the
 * environment cannot (no canvas, an image that does not load, a timeout).
 */
export function rasterizeSvg(svg: string, width: number, height: number, scale = 2): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (blob: Blob | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(blob);
    };
    const timer = window.setTimeout(() => finish(null), RASTER_TIMEOUT_MS);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof canvas.toBlob !== 'function') {
          finish(null);
          return;
        }
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => finish(blob), 'image/png');
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/** Save the chart as a 2× `.png`. Resolves to whether a download started. */
export async function downloadChartPng(req: ChartImageRequest): Promise<boolean> {
  const { svg, width, height } = render(req);
  const blob = await rasterizeSvg(svg, width, height);
  if (!blob) return false;
  return downloadBlob(exportFileName('chart', req.title, 'png'), blob);
}
