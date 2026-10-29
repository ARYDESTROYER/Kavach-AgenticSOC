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
import { statusLabel } from '@/soc/components/semantic-labels';

/**
 * The ONLY link target a model may write: `/docs/<major.minor>/[<path>][/][#anchor]`.
 * The same grammar as the backend `DOC_REF_PATTERN` and `schema.ts` `doc_ref` (both
 * run the shared `doc_ref_examples` vectors): lowercase segments made of dot-joined
 * `[a-z0-9_-]` runs, so the Help Center home (`/docs/0.1/`) and dotted release pages
 * (`/docs/0.1/releases/0.1.13/`) are citable while a `.`/`..`/empty segment, a scheme
 * or host, a query, uppercase, `%`-encoding and backslashes never match. Every
 * repetition is separator-led, so matching stays linear on hostile input.
 */
export const DOC_LINK_RE =
  /^\/docs\/[0-9]{1,4}\.[0-9]{1,4}\/(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\/[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)*\/?)?(?:#[a-z0-9_-]+)?$/;

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

/** The server's calibration bounds (`CALIBRATION_BOUNDS` in routes_chat.py). */
export const CALIBRATION_RANGE = [0.25, 4] as const;

/**
 * The usable calibration factor: clamped to 0.25–4; 1 when absent, non-positive or not
 * a number. The ONE implementation: the composer meter (`composer/format`) re-exports it.
 */
export function calibrationFactor(calibration: number | null | undefined): number {
  if (typeof calibration !== 'number' || !Number.isFinite(calibration) || calibration <= 0) return 1;
  return Math.min(CALIBRATION_RANGE[1], Math.max(CALIBRATION_RANGE[0], calibration));
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
  /** The clamped factor applied to every part (1 = uncalibrated). */
  factor: number;
}

/**
 * Next-request estimate: system (static prompt + the caller's tool signatures) +
 * history + the draft, each × the clamped calibration. The server's calibration is
 * actual ÷ estimate for the WHOLE first prompt of the conversation's last turn, and
 * `static_prompt_tokens` / `history_tokens` are plain chars ÷ 4 estimates, so the
 * factor belongs on every part, not just the draft. Never negative, never NaN.
 */
export function estimateNextRequest(input: NextRequestEstimateInput): NextRequestEstimate {
  const factor = calibrationFactor(input.calibration);
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  const system = Math.round(safe(input.staticPromptTokens) * factor);
  const history = Math.round(safe(input.historyTokens) * factor);
  const draft = estimateTokens(Array.from(input.draft).length, input.charsPerToken, factor);
  return { system, history, draft, total: system + history + draft, factor };
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

/* -------------------------------------------------------------------------- */
/* Product words for engine values (Round 13, SPEC-chat T14).                  */
/* -------------------------------------------------------------------------- */

/**
 * Kinds as the console names them ("Kind ip" read as a raw value): indicator kinds, the
 * reference kinds and the query languages. Unknown kinds keep their own text.
 */
export const KIND_LABEL: Readonly<Record<string, string>> = {
  ip: 'IP',
  domain: 'Domain',
  url: 'URL',
  hash: 'File hash',
  host: 'Host',
  user: 'User',
  email: 'Email',
  process: 'Process',
  file: 'File',
  case: 'Case',
  rule: 'Detection rule',
  source: 'Log source',
  campaign: 'Campaign',
  technique: 'ATT&CK technique',
  kql: 'KQL',
  lucene: 'Lucene',
  esql: 'ES|QL',
  dsl: 'Query DSL',
  sql: 'SQL',
  // Metric kinds whose words need more than sentence case.
  mitre_coverage: 'MITRE ATT&CK coverage',
  auto_close_health: 'Auto-close health',
};

/** "ip" → "IP", "domain" → "Domain"; anything else as written. */
export function kindLabel(value: string): string {
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(KIND_LABEL, key) ? KIND_LABEL[key] : value;
}

/** The case lifecycle values the console knows (`models.CaseStatus` plus the legacy ones). */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'created',
  'new',
  'open',
  'needs_human',
  'investigating',
  'escalated',
  'on_hold',
  'resolved',
  'closed',
]);

/**
 * A known case status in the StatusBadge's own words, through the shared label map
 * (`statusLabel`: "on_hold" → "On hold", "needs_human" → "Open · awaiting analyst"), so a
 * run-log chip, a status-history line and the badge beside it always agree; `null` for a
 * value that is not a known case status (never reworded).
 */
export function caseStatusWord(value: string): string | null {
  const key = value.trim().toLowerCase();
  return KNOWN_STATUSES.has(key) ? statusLabel(key) : null;
}

/*
 * Status history in words (Round 13 T14, Round 14 SPEC §4.6.3): ONE vocabulary, the
 * server's (`chat_tools/common.py` `status_change_label`, `status_change_detail`), for
 * every answer. An answer saved before Round 14 holds the engine's own form ("open ->
 * escalated", "by system: True positive routed to human: tp auto-close disabled."); it
 * reads in the same words a newer answer stores ("Open to Escalated", "Automatic close of
 * a confirmed threat is off (by the system)"), from the tables below. Only the engine's
 * fixed templates and roles are recognised: an analyst's own reason, a person's name or
 * any other text is never reworded (the caller shows it as written, as untrusted text).
 */

/** The case statuses a status move names, in the StatusBadge's words ("Open · awaiting analyst"). */
const MOVE_STATUS_WORDS: readonly string[] = [...KNOWN_STATUSES].filter((key) => key !== 'created').map(statusLabel);

const reEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STATUS_ALT = MOVE_STATUS_WORDS.map(reEscape).join('|');
const STATUS_MOVE_WORDS = new RegExp(`^(?:Created as (?:${STATUS_ALT})|(?:${STATUS_ALT}) to (?:${STATUS_ALT}))$`);

/** Whether `label` is a status move in the server's words ("Open to Escalated", "Created as New"). */
export function isStatusMoveWords(label: string): boolean {
  return STATUS_MOVE_WORDS.test(label.trim());
}

/**
 * A status move in words: "Open to Escalated", and a first status "Created as New". The
 * engine form of an older answer ("open -> escalated", "created -> new") is reworded only
 * when BOTH sides are known statuses; the server's words come back as they are. `null`
 * for anything else, which is never reworded (log or analyst text).
 */
export function statusTransitionLabel(label: string): string | null {
  const match = /^\s*([a-z_]{2,20})\s*->\s*([a-z_]{2,20})\s*$/i.exec(label);
  if (!match) return isStatusMoveWords(label) ? label.trim() : null;
  const fromKey = match[1].toLowerCase();
  const toKey = match[2].toLowerCase();
  const to = toKey === 'created' ? null : caseStatusWord(toKey);
  if (!to) return null;
  if (fromKey === 'created') return `Created as ${to}`;
  const from = caseStatusWord(fromKey);
  return from ? `${from} to ${to}` : null;
}

/** Who moved a case, by role (`chat_tools/common.py` `_ACTOR_WORDS`); a person is never named here. */
const ACTOR_WORDS: Readonly<Record<string, string>> = {
  agent: 'the AI agent',
  system: 'the system',
  analyst: 'an analyst',
  analyst_policy: 'an analyst policy',
};

/** The role's words, or `null` for a name (own keys only: "constructor" is a name). */
function actorWords(key: string): string | null {
  const role = key.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ACTOR_WORDS, role) ? ACTOR_WORDS[role] : null;
}

/** The verdict a decision reason names (`_VERDICT_WORDS`); any other reads "the case". */
const VERDICT_WORDS: Readonly<Record<string, string>> = {
  TRUE_POSITIVE: 'a confirmed threat',
  FALSE_POSITIVE: 'a false positive',
  NEEDS_HUMAN: 'an unclear case',
};
function verdictWords(key: string): string {
  return Object.prototype.hasOwnProperty.call(VERDICT_WORDS, key) ? VERDICT_WORDS[key] : 'the case';
}

/** A figure in a stored rationale (captured), and the same in the words (not captured). */
const NUM = '(-?[0-9]+(?:\\.[0-9]+)?)';
const SAID_NUM = '-?[0-9]+(?:\\.[0-9]+)?';
const VERDICT_KEY = '(TRUE_POSITIVE|FALSE_POSITIVE|NEEDS_HUMAN|\\?)';
const SAID_VERDICT = `(?:${[...Object.values(VERDICT_WORDS), 'the case'].map(reEscape).join('|')})`;

/**
 * The deterministic decision's reasons (`engine/case_manager.py` `decide()` rationales),
 * ONE table: `engine` reads the stored engine text of an older answer, `words` writes the
 * server's words for it (`status_reason_text`), and `said` recognises those words in a
 * newer answer.
 */
const DECISION_REASONS: ReadonlyArray<{ engine: RegExp; words: (m: RegExpExecArray) => string; said: string }> = [
  {
    engine: /^(?:true positive routed to human: )?tp auto-close disabled\.?$/i,
    words: () => 'Automatic close of a confirmed threat is off',
    said: 'Automatic close of a confirmed threat is off',
  },
  {
    engine: /^(?:false positive routed to human: )?fp auto-close disabled\.?$/i,
    words: () => 'Automatic close of a false positive is off',
    said: 'Automatic close of a false positive is off',
  },
  {
    engine: /^no confident close decision; routing to human \(fail-safe\)\.?$/i,
    words: () => 'No confident close decision, so a person decides',
    said: 'No confident close decision, so a person decides',
  },
  {
    engine: new RegExp(
      `^${VERDICT_KEY} routed to human: did not clear the auto-close bar \\(confidence ${NUM} vs ${NUM}, risk ${NUM} vs ${NUM}\\)\\.?$`,
    ),
    words: (m) =>
      `Did not clear the automatic close bar for ${verdictWords(m[1])}: confidence ${m[2]} against ${m[3]}, risk ${m[4]} against ${m[5]}`,
    said: `Did not clear the automatic close bar for ${SAID_VERDICT}: confidence ${SAID_NUM} against ${SAID_NUM}, risk ${SAID_NUM} against ${SAID_NUM}`,
  },
  {
    engine: new RegExp(
      `^${VERDICT_KEY} auto-closed: confidence ${NUM} >= ${NUM} and risk ${NUM} <= ${NUM}; objection window ([0-9]{1,9})m\\.?$`,
    ),
    words: (m) => {
      const minutes = Number(m[6]);
      return (
        `Closed automatically as ${verdictWords(m[1])}: confidence ${m[2]} at or above ${m[3]}, ` +
        `risk ${m[4]} at or below ${m[5]}; objection window ${minutes.toLocaleString('en-US')} ${minutes === 1 ? 'minute' : 'minutes'}`
      );
    },
    said: `Closed automatically as ${SAID_VERDICT}: confidence ${SAID_NUM} at or above ${SAID_NUM}, risk ${SAID_NUM} at or below ${SAID_NUM}; objection window [0-9][0-9,]* minutes?`,
  },
];

const ACTOR_ALT = `(?:${Object.values(ACTOR_WORDS).map(reEscape).join('|')})`;
/** A reason in the server's words: a template "(by <role>)", or "By <role>" alone. */
const SAID_DETAIL = new RegExp(`^(?:(?:${DECISION_REASONS.map((r) => r.said).join('|')}) \\(by ${ACTOR_ALT}\\)|By ${ACTOR_ALT})$`);

/** A stored engine rationale in the server's words, else `null`. */
function decisionReasonWords(text: string): string | null {
  for (const reason of DECISION_REASONS) {
    const match = reason.engine.exec(text);
    if (match) return reason.words(match);
  }
  return null;
}

/**
 * Whether `detail` is a status change's reason in the server's words, from one of the
 * engine's fixed templates and by an engine role ("Automatic close of a confirmed threat
 * is off (by the system)", "By an analyst"). An analyst's own reason, or a person's name,
 * is not.
 */
export function isEngineStatusDetail(detail: string): boolean {
  return SAID_DETAIL.test(detail.trim());
}

/**
 * A status change's reason in the server's words: "Automatic close of a confirmed threat
 * is off (by the system)", "By the AI agent". The engine form of an older answer ("by
 * system: True positive routed to human: tp auto-close disabled.", "tp auto-close
 * disabled", "by agent") is reworded; the server's words come back as they are. `null`
 * for anything else (an analyst's own reason, a person's name, log text), which the
 * caller shows exactly as written.
 */
export function reasonSentence(text: string): string | null {
  const said = text.split(/\s+/).filter(Boolean).join(' ');
  if (!said) return null;
  if (SAID_DETAIL.test(said)) return said;
  const by = /^by ([a-z_]{2,20})(?::\s*(.*))?$/is.exec(said);
  if (!by) return decisionReasonWords(said);
  const actor = actorWords(by[1]);
  if (!actor) return null;
  const body = (by[2] ?? '').trim();
  if (!body) return `By ${actor}`;
  const words = decisionReasonWords(body);
  return words ? `${words} (by ${actor})` : null;
}

/**
 * A run-log chip that names several log sources: "3 sources", with every name in its
 * tooltip; one source reads as its name.
 */
export function sourcesChip(names: readonly string[]): { text: string; title: string } {
  const list = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  if (list.length <= 1) return { text: list[0] ?? '', title: list[0] ?? '' };
  return { text: `${list.length.toLocaleString('en-US')} sources`, title: list.join(', ') };
}
