/**
 * The built-in dashboards (Round 14, SPEC §2.2 and §4.4.1, operator choice C2).
 *
 * The Dashboards library lists four built-in cards, left to right:
 *
 *   1. Cyber Defence Center (badge "Default"): the hand-built landing page. Its card is a
 *      link to `#/overview`; it cannot be hidden, duplicated or edited, so it has no menu.
 *   2. SOC operations (24 hours), 3. Detection and data health (7 days), 4. Executive
 *      summary (30 days): widget boards defined here in code. They are never stored and
 *      update with releases; a person who wants to change one duplicates it into a
 *      personal board (`derived_from` names the built-in it was copied from).
 *
 * Personal boards keep their `DashboardLayout` in the per-user `DashboardStore`. The
 * per-role default board keeps the fixed id `overview` and is named "My dashboard"; a
 * board saved earlier under that id and named exactly "Overview" displays as "My
 * dashboard" and its next save writes the new name ({@link displayBoardName}).
 *
 * Board ids in a link (`#/dashboards?board=...`) use the router's `NAV_ID` grammar. The ids
 * `new`, `builtin:*` and `u:*` are reserved; a personal board stored before Round 14 under
 * a reserved id or an id the grammar refuses is linked under the alias `u:<first 8 hex
 * of SHA-256 of its id>` ({@link boardRouteId}). The client resolves the alias against
 * the loaded list; the API still addresses the board by its stored id.
 *
 * NON-NEGOTIABLES: a layout is presentation only and never feeds `decide()` (#3); every
 * widget here reads aggregates or case rows through the non-billing provider keys (#6,
 * #7); board names are untrusted text rendered as plain text (#9).
 */
import type { DashboardLayout, DashboardWidget } from '@/lib/types';
import type { BuiltinBoardId, BuiltinLandingId, DashboardWindow } from '@/lib/types-dashboards';

import type { WidgetType } from './registry';

// --------------------------------------------------------------------------- //
// Shapes
// --------------------------------------------------------------------------- //

/**
 * One box of a board's outline preview on its library card, in 12-column grid units. A
 * `strip` box (the KPI strip) draws as one thin line; every other box as an outlined
 * module.
 */
export interface OutlineBox {
  x: number;
  y: number;
  w: number;
  h: number;
  strip?: boolean;
}

/** A code-defined widget board (SPEC §4.4.1). */
export interface BuiltinBoard {
  id: BuiltinBoardId;
  name: string;
  badge: 'Built-in';
  /** Who the board is for, without the leading "For" ("SOC managers and shift leads"). */
  audience: string;
  /** The question the board answers. */
  purpose: string;
  /** The window the board's time range starts on. */
  defaultWindow: DashboardWindow;
  /** Whether the board's headline figures compare with the previous window. */
  compare: boolean;
  widgets: DashboardWidget[];
  outline: OutlineBox[];
}

/** The landing page's library card: a link to the hand-built Cyber Defence Center. */
export interface LandingCard {
  id: BuiltinLandingId;
  name: string;
  badge: 'Default';
  href: '#/overview';
  window: 'now-24h';
  audience: string;
  purpose: string;
  outline: OutlineBox[];
}

// --------------------------------------------------------------------------- //
// Ids and names
// --------------------------------------------------------------------------- //

/** The per-role default board's fixed id (kept so boards saved under it still match). */
export const MY_DASHBOARD_ID = 'overview';

/** The per-role default board's name (was "Overview", which collided with the page). */
export const MY_DASHBOARD_NAME = 'My dashboard';

/** The name an unnamed board shows. */
export const UNTITLED_BOARD_NAME = 'Untitled dashboard';

/** The `board` value that opens the builder on an unsaved draft. */
export const NEW_BOARD_ID = 'new';

/** The landing card's id (opened as a board it is the landing page itself). */
export const LANDING_BOARD_ID: BuiltinLandingId = 'builtin:cyber-defence-center';

/** The router's `board` grammar (`router.tsx` `NAV_ID`). */
const NAV_ID = /^[\w.:-]{1,128}$/;

/** Server limits on personal boards (`routes_dashboards.py`). */
export const MAX_PERSONAL_BOARDS = 24;
export const MAX_BOARD_NAME_LENGTH = 120;

/** What the Console says at the board limit (the Duplicate dialog, the Yours tile, a draft). */
export const BOARD_LIMIT_TEXT = `You have ${MAX_PERSONAL_BOARDS} dashboards, the most allowed. Delete one to add another.`;

/** True when `id` may not be used to create a personal board (`new`, `builtin:*`, `u:*`). */
export function isReservedBoardId(id: string): boolean {
  return id === NEW_BOARD_ID || id.startsWith('builtin:') || id.startsWith('u:');
}

/**
 * The name a personal board shows: its stored name, except a board stored under the
 * role-default id and named exactly "Overview" (before Round 14), which reads as "My
 * dashboard"; an empty name reads as "Untitled dashboard". Names are untrusted plain text.
 */
export function displayBoardName(board: Pick<DashboardLayout, 'id' | 'name'>): string {
  const name = typeof board.name === 'string' ? board.name.trim() : '';
  if (board.id === MY_DASHBOARD_ID && (name === 'Overview' || name === '')) return MY_DASHBOARD_NAME;
  return name || UNTITLED_BOARD_NAME;
}

/** "2 panels need permissions your role does not have." (null for none). */
export function unavailableNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? '1 panel needs permissions your role does not have.'
    : `${n.toLocaleString('en-US')} panels need permissions your role does not have.`;
}

/** The name a copy of a board starts with ("SOC operations (copy)"), within the server limit. */
export function copyName(name: string): string {
  const suffix = ' (copy)';
  const base = name.trim() || UNTITLED_BOARD_NAME;
  return `${base.slice(0, MAX_BOARD_NAME_LENGTH - suffix.length)}${suffix}`;
}

// --------------------------------------------------------------------------- //
// SHA-256 (synchronous): the `u:` alias of an older board id
// --------------------------------------------------------------------------- //
// `crypto.subtle` is asynchronous and missing outside a secure context (a Console served
// over plain http on a LAN address), and a link is rendered synchronously, so the digest
// is computed here. FIPS 180-4.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** The SHA-256 digest of `text` (UTF-8) as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = bytes.length;
  const total = Math.ceil((length + 9) / 64) * 64;
  const buffer = new Uint8Array(total);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, Math.floor(length / 0x20000000));
  view.setUint32(total - 4, (length * 8) >>> 0);

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** The `u:<sha8>` alias of a stored board id. */
export function boardAlias(id: string): string {
  return `u:${sha256Hex(id).slice(0, 8)}`;
}

/**
 * The `board` value a personal board is linked under: its own id, or its `u:` alias when
 * the id is reserved or fails the link grammar (a board stored before Round 14).
 */
export function boardRouteId(id: string): string {
  return isReservedBoardId(id) || !NAV_ID.test(id) ? boardAlias(id) : id;
}

// --------------------------------------------------------------------------- //
// Outline previews
// --------------------------------------------------------------------------- //

/** The outline of a widget list (the built-ins' and a personal board's saved geometry). */
export function outlineFromWidgets(widgets: readonly DashboardWidget[]): OutlineBox[] {
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
  return widgets.map((widget) => {
    const x = Math.min(11, num(widget.x, 0));
    return {
      x,
      y: num(widget.y, 0),
      w: Math.max(1, Math.min(12 - x, num(widget.w, 4) || 1)),
      h: Math.max(1, num(widget.h, 4) || 1),
      strip: widget.type === 'kpi.strip',
    };
  });
}

/** One band of an outline: the boxes that start on the same row, left to right. */
export interface OutlineRow {
  strip: boolean;
  boxes: OutlineBox[];
}

/** The most bands an outline draws (a long board keeps its first bands). */
const MAX_OUTLINE_ROWS = 7;

/**
 * Group outline boxes into bands by their top row, in reading order. A band holding only
 * the KPI strip draws as one thin line. Boxes that all sit at the origin (a role default
 * not yet placed) flow left to right, wrapping at 12 columns, the way view mode packs them.
 */
export function outlineRows(boxes: readonly OutlineBox[]): OutlineRow[] {
  let placed = [...boxes];
  if (placed.length > 1 && placed.every((b) => b.x === 0 && b.y === 0)) {
    let cx = 0;
    let row = 0;
    placed = placed.map((b) => {
      if (cx + b.w > 12) {
        cx = 0;
        row += 1;
      }
      const next = { ...b, x: cx, y: row };
      cx += b.w;
      return next;
    });
  }
  const bands = new Map<number, OutlineBox[]>();
  for (const box of placed.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const band = bands.get(box.y);
    if (band) band.push(box);
    else bands.set(box.y, [box]);
  }
  return [...bands.values()]
    .slice(0, MAX_OUTLINE_ROWS)
    .map((band) => ({ strip: band.every((b) => b.strip), boxes: band }));
}

// --------------------------------------------------------------------------- //
// The boards
// --------------------------------------------------------------------------- //

/** One placed widget of a built-in board (ids are stable so a copy keeps them). */
function place(
  board: string,
  type: WidgetType,
  x: number,
  y: number,
  w: number,
  h: number,
  options: Record<string, unknown> = {},
): DashboardWidget {
  const slug = type.replace(/[^a-z0-9]+/gi, '-');
  return { i: `${board}-${slug}-${x}-${y}`, type, x, y, w, h, options } as DashboardWidget;
}

function board(def: Omit<BuiltinBoard, 'badge' | 'outline'>): BuiltinBoard {
  return { ...def, badge: 'Built-in', outline: outlineFromWidgets(def.widgets) };
}

/**
 * SOC operations, the last 24 hours (SPEC §4.4.4):
 *
 *   [ KPI strip: Open now | Awaiting a decision | Unassigned | SLA breached | New cases | Closed ]
 *   [ Arrivals and closures (8)                  ][ Human vs AI (4)           ]
 *   [ Needs attention now (8)                    ][ Analyst workload (4)      ]
 *   [ Backlog aging (4) ][ SLA breaches and at risk (4) ][ Open cases by status (4) ]
 *   [ Response timing: MTTD, MTTA, MTTR, Dwell (12)                            ]
 */
const SOC_OPERATIONS = board({
  id: 'builtin:soc-operations',
  name: 'SOC operations',
  audience: 'SOC managers and shift leads',
  purpose: 'Is the team keeping up today?',
  defaultWindow: 'now-24h',
  compare: true,
  widgets: [
    place('ops', 'kpi.strip', 0, 0, 12, 3, { preset: 'operations' }),
    place('ops', 'chart.case_trend', 0, 3, 8, 6, { series: 'flow' }),
    place('ops', 'chart.autonomous_vs_human', 8, 3, 4, 6),
    place('ops', 'table.attention_queue', 0, 9, 8, 6, { limit: 8 }),
    place('ops', 'table.workload', 8, 9, 4, 6),
    place('ops', 'chart.backlog_aging', 0, 15, 4, 5),
    place('ops', 'table.sla_breaches', 4, 15, 4, 5),
    place('ops', 'chart.case_breakdown', 8, 15, 4, 5, { by: 'status', population: 'open' }),
    place('ops', 'kpi.lifecycle_timing', 0, 20, 12, 3),
  ],
});

/**
 * Detection and data health, the last 7 days (SPEC §4.4.4):
 *
 *   [ KPI strip: Sources reporting | Silent sources | Events per minute | Alerts ingested | Alert reduction | Techniques seen ]
 *   [ Alerts and cases over time (8)             ][ Noise reduction (4)       ]
 *   [ Top detection rules (6)          ][ Noisiest rules (6)                   ]
 *   [ Connector health (6)             ][ Cases by source (6)                  ]
 *   [ Techniques seen in cases (8)               ][ Top techniques (4)        ]
 *   [ Auto-close health (4) ][ Telemetry gaps (8)                             ]
 */
const DETECTION_DATA_HEALTH = board({
  id: 'builtin:detection-data-health',
  name: 'Detection and data health',
  audience: 'detection engineers and platform admins',
  purpose: 'Are we seeing everything, and are the detections any good?',
  defaultWindow: 'now-7d',
  compare: false,
  widgets: [
    place('det', 'kpi.strip', 0, 0, 12, 3, { preset: 'detection' }),
    place('det', 'chart.case_trend', 0, 3, 8, 5, { series: 'alerts' }),
    place('det', 'chart.noise_funnel', 8, 3, 4, 5),
    place('det', 'table.top_rules', 0, 8, 6, 6, { top: 10 }),
    place('det', 'table.noisy_rules', 6, 8, 6, 6),
    place('det', 'table.connector_health', 0, 14, 6, 5),
    place('det', 'chart.case_breakdown', 6, 14, 6, 5, { by: 'source' }),
    place('det', 'mitre.heatmap', 0, 19, 8, 6),
    place('det', 'table.top_techniques', 8, 19, 4, 6, { top: 10 }),
    place('det', 'kpi.auto_close_health', 0, 25, 4, 5),
    place('det', 'table.telemetry_gaps', 4, 25, 8, 5),
  ],
});

/**
 * Executive summary, the last 30 days (SPEC §4.4.4):
 *
 *   [ KPI strip: Cases | Confirmed threats | MTTD p50 | MTTR p50 | Closed by the AI agent | SLA attainment ]
 *   [ Cases by severity over time (8)            ][ Active risk index (4)     ]
 *   [ Outcomes over time (8)                     ][ Human vs AI (4)           ]
 *   [ Top ATT&CK techniques (4) ][ Cases by source (4) ][ AI spend (4)         ]
 *   [ Active campaigns (6)             ][ Agent quality (6)                    ]
 */
const EXECUTIVE_SUMMARY = board({
  id: 'builtin:executive-summary',
  name: 'Executive summary',
  audience: 'the CISO and leadership',
  purpose: 'Are we safer and faster than last month, and what does automation cost?',
  defaultWindow: 'now-30d',
  compare: true,
  widgets: [
    place('exec', 'kpi.strip', 0, 0, 12, 3, { preset: 'executive' }),
    place('exec', 'chart.severity_trend', 0, 3, 8, 5),
    place('exec', 'gauge.active_risk', 8, 3, 4, 5),
    // One metric family per chart (§4.4.2): the AI verdicts, named in the caption.
    place('exec', 'chart.case_trend', 0, 8, 8, 6, { series: 'outcomes', family: 'ai' }),
    place('exec', 'chart.autonomous_vs_human', 8, 8, 4, 6),
    place('exec', 'table.top_techniques', 0, 14, 4, 6, { top: 5, title: 'Top ATT&CK techniques' }),
    place('exec', 'chart.case_breakdown', 4, 14, 4, 6, { by: 'source', top: 5 }),
    place('exec', 'kpi.cost_budget', 8, 14, 4, 6),
    place('exec', 'table.campaigns', 0, 20, 6, 5),
    place('exec', 'kpi.agent_quality', 6, 20, 6, 5),
  ],
});

/** The three widget boards, in library order. */
export const BUILTIN_BOARDS: readonly BuiltinBoard[] = [SOC_OPERATIONS, DETECTION_DATA_HEALTH, EXECUTIVE_SUMMARY];

/** The landing page's card (first in the library). */
export const LANDING_CARD: LandingCard = {
  id: LANDING_BOARD_ID,
  name: 'Cyber Defence Center',
  badge: 'Default',
  href: '#/overview',
  window: 'now-24h',
  audience: 'everyone',
  purpose: 'The landing page: alert flow, case state and response time right now.',
  // The Overview's own rows: the KPI strip, the flow row (8 + 4), the cases row
  // (5 + 3 + 4) and the deeper analytics below.
  outline: [
    { x: 0, y: 0, w: 12, h: 1, strip: true },
    { x: 0, y: 1, w: 8, h: 1 },
    { x: 8, y: 1, w: 4, h: 1 },
    { x: 0, y: 2, w: 5, h: 1 },
    { x: 5, y: 2, w: 3, h: 1 },
    { x: 8, y: 2, w: 4, h: 1 },
    { x: 0, y: 3, w: 12, h: 1 },
  ],
};

/** True when `id` names one of the three widget boards. */
export function isBuiltinBoardId(id: string): id is BuiltinBoardId {
  return BUILTIN_BOARDS.some((b) => b.id === id);
}

/** The widget board with this id, if any. */
export function builtinBoard(id: string): BuiltinBoard | undefined {
  return BUILTIN_BOARDS.find((b) => b.id === id);
}

/** The name of a built-in (for "Copied from SOC operations"), or undefined. */
export function builtinName(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  if (id === LANDING_BOARD_ID) return LANDING_CARD.name;
  return builtinBoard(id)?.name;
}

/**
 * The hidden built-ins in a `misc.dashboards_hidden` value: widget-board ids only (never
 * the landing card), each once, unknown ids dropped (the server normalises the same way).
 */
export function hiddenBuiltinIds(value: unknown): BuiltinBoardId[] {
  if (!Array.isArray(value)) return [];
  const out: BuiltinBoardId[] = [];
  for (const id of value) {
    if (typeof id === 'string' && isBuiltinBoardId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
