/**
 * Small pure display helpers for the chat route chunk (SPEC §7.1, §8; BLOCKS.md
 * amendments 4–5).
 *
 * Everything here works on UNTRUSTED text (model prose, log-derived values) and only
 * ever returns strings or plain data for React text nodes — never markup, never an
 * `href` built from model text. The one link a model may write is a same-origin Help
 * Center page, recognised by {@link isDocLink} (the BLOCKS.md amendment 5 pattern,
 * identical to the backend `Citation.doc` rule).
 */

/** The ONLY link target a model may write: `/docs/<major.minor>/<path>[/][#anchor]`. */
export const DOC_LINK_RE = /^\/docs\/\d+\.\d+\/[a-z0-9/_-]+\/?(#[a-z0-9_-]+)?$/;

/** True for a same-origin Help Center path (see {@link DOC_LINK_RE}); rejects `..`. */
export function isDocLink(target: unknown): target is string {
  return typeof target === 'string' && target.length <= 300 && DOC_LINK_RE.test(target) && !target.includes('//', 1);
}

/** Schemes that make a string an external URL (rendered defanged, never a link). */
const URL_SCHEME_RE = /^(https?|ftps?|wss?):\/\//i;

/**
 * Bare external URLs inside prose: a scheme, `://`, then a run of non-space characters;
 * trailing sentence punctuation and an unbalanced closing bracket are left outside the
 * URL so "see https://x.example/a)." keeps its ")". No word boundary is required before
 * the scheme: a URL glued to a word (`foohttps://evil.example`) is still split out and
 * defanged — over-defanging is harmless, a live-looking URL is not.
 */
const BARE_URL_RE = /(?:https?|ftps?|wss?):\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

/**
 * Defang an external URL for display or copy: the scheme loses its live form
 * (`http` → `hxxp`, `ftp` → `fxp`, `ws` → `wxs`) and every dot in the host becomes
 * `[.]`. The path is left readable. Idempotent on already-defanged text.
 */
export function defangUrl(url: string): string {
  const match = /^([a-z]+):\/\/([^/?#]*)(.*)$/is.exec(url);
  if (!match) return url.replace(/\./g, '[.]');
  const [, scheme, host, rest] = match;
  const lower = scheme.toLowerCase();
  const safeScheme = lower.startsWith('http')
    ? `hxxp${lower.slice(4)}`
    : lower.startsWith('ftp')
      ? `fxp${lower.slice(3)}`
      : lower.startsWith('ws')
        ? `wxs${lower.slice(2)}`
        : lower;
  return `${safeScheme}://${host.replace(/(?<!\[)\.(?!\])/g, '[.]')}${rest}`;
}

/** True when `text` is an external URL (any scheme in {@link URL_SCHEME_RE}). */
export function isExternalUrl(text: string): boolean {
  return URL_SCHEME_RE.test(text.trim());
}

/** One run of prose: plain text, or a bare external URL to render defanged. */
export type UrlSegment = { kind: 'text'; text: string } | { kind: 'url'; url: string; defanged: string };

/**
 * Split prose into text and bare-URL runs so a renderer can show each URL defanged
 * with a copy button (BLOCKS.md amendment 5) while the rest stays plain text. Never
 * linkifies. Returns `[{kind:'text', text}]` when there is no URL.
 */
export function splitBareUrls(text: string): UrlSegment[] {
  const out: UrlSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(BARE_URL_RE)) {
    const start = match.index ?? 0;
    let url = match[0];
    const trailing = TRAILING_PUNCT_RE.exec(url);
    if (trailing) url = url.slice(0, url.length - trailing[0].length);
    if (!url || !URL_SCHEME_RE.test(url) || url.length <= url.indexOf('://') + 3) continue;
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'url', url, defanged: defangUrl(url) });
    last = start + url.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out.length ? out : [{ kind: 'text', text }];
}

/* -------------------------------------------------------------------------- */
/* Token estimates (SPEC §8: chars / 4 × calibration, labelled "≈").           */
/* -------------------------------------------------------------------------- */

/** The default characters-per-token ratio (`/chat/context.chars_per_token`). */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Estimate tokens for `chars` characters: `ceil(chars / charsPerToken × calibration)`.
 * A non-finite or non-positive ratio falls back to {@link DEFAULT_CHARS_PER_TOKEN}; a
 * calibration outside 0.25–4 (or missing) is ignored, so one odd turn cannot make the
 * meter absurd.
 */
export function estimateTokens(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN, calibration?: number | null): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  const ratio = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const factor =
    typeof calibration === 'number' && Number.isFinite(calibration) && calibration >= 0.25 && calibration <= 4
      ? calibration
      : 1;
  return Math.ceil((chars / ratio) * factor);
}

/** Inputs for {@link estimateNextRequest} (all from `GET /api/chat/context`). */
export interface NextRequestEstimateInput {
  staticPromptTokens: number;
  historyTokens: number;
  draft: string;
  charsPerToken?: number;
  calibration?: number | null;
}

/** The composer's "≈ next request" figure and its parts (SPEC §8 item 1). */
export interface NextRequestEstimate {
  system: number;
  history: number;
  draft: number;
  total: number;
}

/**
 * Next-request estimate: system (static prompt + the caller's tool signatures) +
 * history + the draft, with the calibration applied to the draft only (the server
 * already calibrates its own figures). Never negative, never NaN.
 */
export function estimateNextRequest(input: NextRequestEstimateInput): NextRequestEstimate {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  const system = safe(input.staticPromptTokens);
  const history = safe(input.historyTokens);
  const draft = estimateTokens(Array.from(input.draft).length, input.charsPerToken, input.calibration);
  return { system, history, draft, total: system + history + draft };
}

/**
 * The "up to ≈ M for the whole turn" bound (SPEC §8): `min(ceiling, N × max_model_calls
 * + max_tool_calls × observation_chars / chars_per_token)`.
 */
export function projectTurnMaxTokens(
  nextRequest: number,
  bounds: { max_model_calls: number; max_tool_calls: number; observation_chars: number; turn_token_ceiling: number },
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  const ratio = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  const raw =
    Math.max(0, nextRequest) * Math.max(1, bounds.max_model_calls) +
    (Math.max(0, bounds.max_tool_calls) * Math.max(0, bounds.observation_chars)) / ratio;
  const ceiling = Math.max(0, bounds.turn_token_ceiling);
  return Math.ceil(ceiling > 0 ? Math.min(ceiling, raw) : raw);
}
