/**
 * Shared, framework-free formatting helpers (copied verbatim from the former
 * Kibana plugin — they have no Kibana/EUI dependency, so they are reused here).
 *
 * These are intentionally pure (no React / no EUI) so they can be reused by every
 * component and unit-reasoned about. Keep them defensive: the backend may send
 * `undefined`, `null`, empty strings, or unparseable values, and a triage console
 * must degrade to a readable dash rather than throwing.
 */

/** A neutral placeholder used everywhere a value is missing. */
export const DASH = '—';

/**
 * Humanize an ISO timestamp into a short relative age (e.g. "3h ago").
 * Returns {@link DASH} for missing / unparseable input.
 */
export function humanizeAge(iso?: string | null): string {
  if (!iso) {
    return DASH;
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return DASH;
  }
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Humanize a future deadline (for example "in 7d"). Unlike humanizeAge this
 * never clamps a future timestamp to "just now", which would make an approval
 * appear to expire immediately. Past deadlines are explicit.
 */
export function humanizeUntil(iso?: string | null): string {
  if (!iso) return DASH;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return DASH;
  const secs = Math.round((then - Date.now()) / 1000);
  if (secs <= 0) return 'expired';
  if (secs < 45) return 'in <1m';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `in ${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `in ${months}mo`;
  return `in ${Math.round(months / 12)}y`;
}

/**
 * Render an ISO timestamp as a compact, human-readable local datetime, e.g.
 * "Jun 17, 2026, 07:13". Falls back to the raw string (then {@link DASH}).
 */
export function formatTimestamp(iso?: string | null): string {
  if (!iso) {
    return DASH;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return iso;
  }
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Common ISO-4217 currency CODE → symbol map (the backend sends codes, not symbols). */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  INR: '₹',
  CAD: '$',
  AUD: '$',
};

/**
 * Resolve a currency argument to a display prefix. The backend cost ledger sends a
 * 3-letter ISO code (e.g. `"USD"`), NOT a symbol, so a bare `"USD"` prefix produced
 * `"USD0.05"`; map known codes to their symbol. A value that is already a symbol
 * (`"$"`, `"€"`) or a short marker (≤2 chars) is used verbatim; an unknown longer
 * code falls back to a `"CODE "` prefix so it stays readable.
 */
function currencySymbol(currency?: string): string {
  if (!currency) return '$';
  const known = CURRENCY_SYMBOLS[currency.toUpperCase()];
  if (known) return known;
  if (currency.length <= 2) return currency;
  return `${currency} `;
}

/**
 * Format a monetary value. Small spends are shown with 4 decimals (the cost
 * ledger routinely deals in fractions of a cent); larger ones with 2, and the
 * integer part is grouped with thousands separators to match {@link fmtNumber}.
 * `currency` is an ISO code (e.g. `"USD"`) or a symbol — see {@link currencySymbol}.
 */
export function fmtMoney(v: number | undefined | null, currency?: string): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  const symbol = currencySymbol(currency);
  const decimals = Math.abs(v) >= 1 ? 2 : 4;
  const amount = v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${symbol}${amount}`;
}

/** Format an integer-ish count with thousands separators ("12,345"). */
export function fmtNumber(v: number | undefined | null): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  try {
    return v.toLocaleString();
  } catch {
    return String(v);
  }
}

/** Format a tokens count compactly (e.g. 2085 -> "2.1K", 12000 -> "12K", 850 -> "850"). */
export function fmtTokens(v: number | undefined | null): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  if (v >= 1000) {
    return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K`;
  }
  return fmtNumber(v);
}

/**
 * Format a 0..1 confidence (or a 0..100 value) as a percentage string. Values
 * <= 1 are treated as a fraction; larger values are treated as already-percent.
 */
export function fmtPercent(v: number | undefined | null): string {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return DASH;
  }
  const pct = v <= 1 ? v * 100 : v;
  return `${Math.round(pct)}%`;
}

/** Convert a 0..1 confidence (or 0..100) to a clamped 0..100 number. */
export function toPercentValue(v: number | undefined | null): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    return 0;
  }
  const pct = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * Sentence-case an enum-ish token: "needs_human" -> "Needs human".
 *
 * Force-lowercasing the remainder mangles acronyms and proper nouns ("US" -> "Us",
 * "OpenAI" -> "Openai", "United States" -> "United states"), so we PRESERVE the
 * author's casing when the source is mixed-case ("OpenAI", "United States") or a short
 * all-caps acronym ("US", "AWS"). A plain single-case enum token ("needs_human",
 * "FALSE_POSITIVE") is still sentence-cased for a calm, uniform read.
 */
export function humanizeToken(token?: string | null): string {
  if (!token) {
    return DASH;
  }
  const spaced = token.replace(/[_-]+/g, ' ').trim();
  if (!spaced) {
    return DASH;
  }
  const rest = spaced.slice(1);
  const hasLower = /[a-z]/.test(spaced);
  const isAcronymish =
    (hasLower && /[A-Z]/.test(rest)) || (!hasLower && spaced.replace(/\s+/g, '').length <= 3);
  if (isAcronymish) {
    return spaced.charAt(0).toUpperCase() + rest;
  }
  return spaced.charAt(0).toUpperCase() + rest.toLowerCase();
}

/*
 * Round 14 (SPEC §4.9.5): durations, overages and case labels. Defined in their own
 * module and only RE-EXPORTED here, so the entry chunk (this module is an entry module)
 * never carries them: Rollup keeps a re-export-only module in the lazy chunks that use it.
 */
export { caseLabel, fmtDuration, fmtOverage, type CaseLabelSource } from './format-values';
