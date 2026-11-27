/**
 * DEV-ONLY Round 12 fixtures (WP-BLK): the new block shapes in the WIRE form the server
 * sends (`backend/app/agents/blocks.py`): a daily calendar series cut in a non-UTC zone
 * with `allowed_rebin`, a monthly series with the current month in progress, a period
 * comparison as grouped columns and as tiles, and an infographic Brief. Values are
 * synthetic. Never imported by production code (kept apart from `gallery.ts`, whose
 * block count other packages' tests pin).
 */
import { parseBlocks } from '../schema';
import type { AnswerBlock } from '../schema';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Asia/Kolkata is UTC+05:30 all year (no DST): local midnight is 18:30 UTC the day before. */
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** `n` local days from `y-m-d` in Asia/Kolkata: `[utcInstants, labels]`. */
export function istDays(y: number, m: number, d: number, n: number): [string[], string[]] {
  const values: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const local = Date.UTC(y, m - 1, d + i);
    const date = new Date(local);
    values.push(new Date(local - IST_OFFSET_MS).toISOString().replace('.000Z', 'Z'));
    labels.push(`${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`);
  }
  return [values, labels];
}

/** A deterministic daily count with a weekly rhythm and a spike. */
export function dailyCount(i: number): number {
  return 20 + ((i * 7) % 11) + (i % 7 === 5 ? 9 : 0) + (i === 40 ? 35 : 0);
}

const [DAYS, DAY_LABELS] = istDays(2026, 8, 1, 70); // 1 Aug → 9 Oct 2026

const MONTH_STARTS = Array.from({ length: 12 }, (_, i) => {
  const t = Date.UTC(2025, 10 + i, 1);
  return new Date(t).toISOString().replace('.000Z', 'Z');
});
const MONTH_LABELS = MONTH_STARTS.map((v) => {
  const d = new Date(v);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
});

export const ROUND12_RAW: unknown[] = [
  {
    id: 'daily-cases',
    type: 'chart',
    kind: 'bar',
    title: 'Cases opened per day',
    caption: '1 Aug – 9 Oct 2026 · Asia/Kolkata',
    provenance: 'code',
    artifact_kind: 'series',
    allowed_views: ['line', 'area', 'bar', 'sparkline', 'table'],
    unit: 'count',
    last_in_progress: true,
    x: { kind: 'time', values: DAYS, labels: DAY_LABELS, bucket: '1d', tz: 'Asia/Kolkata' },
    series: [{ key: 'cases', label: 'Cases', values: DAYS.map((_, i) => dailyCount(i)) }],
    allowed_rebin: ['1w', '1M'],
  },
  {
    id: 'monthly-alerts',
    type: 'chart',
    kind: 'line',
    title: 'Alerts by month',
    caption: 'Last 12 months',
    provenance: 'source',
    artifact_kind: 'series',
    allowed_views: ['line', 'area', 'bar', 'stacked_bar', 'table'],
    unit: 'count',
    last_in_progress: true,
    x: { kind: 'time', values: MONTH_STARTS, labels: MONTH_LABELS, bucket: '1M', tz: 'UTC' },
    series: [
      { key: 'wazuh', label: 'Wazuh', values: [4100, 3900, 4400, 4700, 5200, 4900, 5600, 6100, 5800, 6400, 6900, 2300] },
      { key: 'elastic', label: 'Elastic', values: [2100, 2300, 2200, 2600, 2500, 2900, 3100, 3000, 3300, 3500, 3400, 1200] },
    ],
    allowed_rebin: ['1q', '1y'],
  },
  {
    id: 'compare-bars',
    type: 'chart',
    kind: 'grouped_bar',
    title: 'October against September',
    caption: 'Oct 2026 (to date) vs Sep 2026',
    provenance: 'code',
    artifact_kind: 'comparison',
    allowed_views: ['grouped_bar', 'hbar', 'table'],
    unit: 'count',
    x: { kind: 'category', values: ['Cases opened', 'Closed automatically', 'Escalated', 'Closed by an analyst'], label: 'Metric' },
    series: [
      { key: 'p1', label: 'Sep 2026', values: [1188, 702, 0, 311] },
      { key: 'p2', label: 'Oct 2026', values: [1284, 790, 5, 298] },
    ],
  },
  {
    id: 'compare-tiles',
    type: 'kpi_group',
    title: 'Change versus the previous period',
    provenance: 'code',
    artifact_kind: 'comparison',
    allowed_views: ['kpi_group'],
    items: [
      {
        key: 'cases',
        label: 'Cases opened',
        value: 1284,
        unit: 'count',
        delta: { value: 96, period_label: 'vs Sep 2026', good_direction: 'none' },
        context: 'Sep 2026: 1,188 · +8.1%',
        trend: { points: [1102, 1188, 1284], window_label: 'Aug 2026 – Oct 2026' },
      },
      {
        key: 'fp',
        label: 'False-positive rate',
        value: 18.4,
        unit: 'percent',
        delta: { value: 2.1, period_label: 'vs Sep 2026', good_direction: 'down' },
        context: 'Sep 2026: 16.3% · +12.9% · n < 20',
      },
      {
        key: 'esc',
        label: 'Escalated',
        value: 5,
        unit: 'count',
        delta: { value: 5, period_label: 'vs Sep 2026', good_direction: 'down' },
        context: 'Sep 2026: 0 · new',
      },
      {
        key: 'mttr',
        label: 'MTTR median',
        value: 42,
        unit: 'minutes',
        delta: { value: -6, period_label: 'vs Sep 2026', good_direction: 'down' },
        context: 'Sep 2026: 48 min · -12.5%',
      },
    ],
  },
  {
    id: 'posture-infographic',
    type: 'report',
    provenance: 'ai',
    artifact_kind: null,
    title: 'Posture infographic, Q3 2026',
    subtitle: 'Q3 2026 (Asia/Kolkata)',
    template: 'infographic',
    layout: 'infographic',
    scope: { window_label: 'Q3 2026', sources: ['Wazuh', 'Elastic'], generated_at: '2026-10-09T08:00:00Z' },
    sections: [
      {
        id: 'summary',
        heading: 'Summary',
        blocks: [
          { id: 'ig-md', type: 'markdown', provenance: 'ai', text: '**3,642 cases** in Q3 2026, false-positive rate **18.4%**.' },
          {
            id: 'ig-kpis',
            type: 'kpi_group',
            title: 'Security posture',
            provenance: 'code',
            artifact_kind: 'kpis',
            allowed_views: ['kpi_group', 'table'],
            items: [
              { key: 'cases', label: 'Cases', value: 3642, unit: 'count', trend: { points: [1102, 1188, 1352], window_label: 'Jul – Sep 2026' } },
              { key: 'fp', label: 'False-positive rate', value: 18.4, unit: 'percent' },
              { key: 'auto', label: 'Closed automatically', value: 61.2, unit: 'percent' },
              { key: 'open', label: 'Open now', value: 37, unit: 'count', semantic: 'high' },
            ],
          },
          { id: 'ig-h1', type: 'callout', provenance: 'code', tone: 'info', text: 'False-positive rate 18.4% over 3,642 cases.' },
          { id: 'ig-h2', type: 'callout', provenance: 'code', tone: 'success', text: '61% of closed cases were closed automatically.' },
          { id: 'ig-h3', type: 'callout', provenance: 'code', tone: 'warning', text: '37 cases are open now.' },
        ],
      },
      {
        id: 'volume',
        heading: 'Volume',
        blocks: [
          {
            id: 'ig-months',
            type: 'chart',
            kind: 'bar',
            title: 'Cases opened per month',
            provenance: 'code',
            artifact_kind: 'series',
            allowed_views: ['line', 'area', 'bar', 'table'],
            unit: 'count',
            x: { kind: 'time', values: MONTH_STARTS.slice(8, 11), labels: MONTH_LABELS.slice(8, 11), bucket: '1M', tz: 'UTC' },
            series: [{ key: 'cases', label: 'Cases', values: [1102, 1188, 1352] }],
          },
          {
            id: 'ig-sev',
            type: 'chart',
            kind: 'donut',
            title: 'Cases by severity',
            provenance: 'code',
            artifact_kind: 'categories',
            allowed_views: ['donut', 'hbar', 'bar', 'table'],
            unit: 'count',
            x: { kind: 'category', values: ['critical', 'high', 'medium', 'low'] },
            series: [{ key: 'cases', label: 'Cases', values: [212, 840, 1730, 860] }],
          },
        ],
      },
      {
        id: 'rules',
        heading: 'Top rules',
        blocks: [
          {
            id: 'ig-rules',
            type: 'table',
            title: 'Rules that opened the most cases',
            provenance: 'code',
            artifact_kind: 'table',
            allowed_views: ['table'],
            columns: [
              { key: 'rule', label: 'Rule', type: 'text', untrusted: true },
              { key: 'cases', label: 'Cases', type: 'number', unit: 'count' },
            ],
            rows: [
              ['SSH brute force', 802],
              ['Impossible travel', 411],
              ['Malware beacon', 206],
            ],
          },
        ],
      },
    ],
  },
];

/** Every Round 12 fixture block, parsed exactly as the transcript would parse it. */
export function round12Blocks(): AnswerBlock[] {
  return parseBlocks(ROUND12_RAW, { limit: ROUND12_RAW.length }).blocks;
}

/** One Round 12 fixture block by id. */
export function round12Block(id: string): AnswerBlock {
  const b = round12Blocks().find((x) => x.id === id);
  if (!b) throw new Error(`round 12 block ${id} missing`);
  return b;
}
