/**
 * "Ask AI" entity references (Round 12 WP-ASK; SPEC §4 WP-ASK, SYNTHESIS-chat P1-5).
 *
 * A chip asks about ONE value of one kind (IP, host, user, file hash, domain, URL, email
 * address, detection rule, case). It hands the chat page a TYPED REFERENCE
 * `{ kind, value }` (`NavOpts.entity`), never free text: the page resolves it with
 * `POST /api/chat/entity-question`, which words the question on the server, and sends
 * that question with `origin: "starter"` (the topic pattern, SPEC A7). The value is log-
 * or case-derived, so it is never analyst-authored for the indicator taint rule (#9):
 * a third-party lookup of it runs only when the policy allows it.
 *
 * This module only decides WHETHER a chip has something to ask: the server's grammar for
 * each kind, mirrored here so the console never shows a chip the server would refuse.
 * An IP must parse as an IP, a hash is 32, 40 or 64 hex digits, a URL, email address or
 * domain has its ASCII shape, and a host, user, rule or case is one identifier token
 * (letters, digits and `_ . @ \ $ : / # + -`): no whitespace, quotes, angle brackets or
 * invisible characters, so a value can never carry a sentence of its own. Anything else
 * gets no chip; a value is trimmed, never altered. Both sides are pinned to the shared
 * table in `ask-ai.contract.json` (`backend/app/agents/chat_entity.py`).
 *
 * Dependency-free on purpose: it ships in the chip's on-demand chunk (`AskAiChip.tsx`,
 * "Loading"). A module shared with a route chunk would become its own chunk named in the
 * entry chunk's preload lists, which sit at their size ceiling; that is why the invisible
 * ranges below are a copy (pinned equal to `stream-events.ts` and the backend by tests).
 */

/** The entity kinds a chip can ask about (the server's `EntityAskKind`, same order). */
export type AskEntityKind = 'ip' | 'host' | 'user' | 'hash' | 'domain' | 'url' | 'email' | 'rule' | 'case';

/** Every kind, in the server's order (`ask-ai.contract.json`). */
export const ASK_ENTITY_KINDS: readonly AskEntityKind[] = [
  'ip',
  'host',
  'user',
  'hash',
  'domain',
  'url',
  'email',
  'rule',
  'case',
];

/** What a chip hands the chat page (`NavOpts.entity`). */
export interface AskEntityRef {
  kind: AskEntityKind;
  value: string;
}

/** The longest value any kind accepts (the request bound; each kind has its own). */
export const ASK_ENTITY_VALUE_MAX = 512;

const KIND_MAX: Readonly<Record<AskEntityKind, number>> = {
  ip: 45,
  hash: 64,
  domain: 253,
  url: 512,
  email: 254,
  host: 256,
  user: 256,
  rule: 256,
  case: 128,
};

/** The longest value shown inside the chip's accessible name (display only). */
const LABEL_VALUE_MAX = 80;

/**
 * The invisible, control, bidi and separator code points (the backend
 * `INVISIBLE_TEXT_RANGES`, identical to `stream-events.ts`; see the module note for why
 * this is a copy). Hangul fillers, the combining grapheme joiner and the variation
 * selectors are letters or marks, so a letter-and-digit grammar alone would let them in.
 */
export const ASK_INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

function hasInvisible(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ASK_INVISIBLE_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) return true;
  }
  return false;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const HASH = /^(?:[0-9A-Fa-f]{32}|[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/;
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const TLD = '(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})';
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+${TLD}$`);
const EMAIL = new RegExp(`^[A-Za-z0-9._%+-]{1,64}@(?:${LABEL}\\.)+${TLD}$`);
// Printable ASCII with no whitespace, quotes, angle brackets, backslash, braces, pipe,
// caret or backtick; a host is required after the scheme.
const URL_SHAPE = /^(?:https?|hxxps?):\/\/[^\s/?#"'<>`\\{}|^]+[^\s"'<>`\\{}|^]*$/i;
const PRINTABLE_ASCII = /^[!-~]+$/;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// One identifier token: a letter, digit or the allowed punctuation first (never a bare
// combining mark), then marks too; at least one letter or digit (checked separately).
const IDENTIFIER = /^[\p{L}\p{N}_.@\\$:/#+-][\p{L}\p{N}\p{M}_.@\\$:/#+-]*$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * An IPv6 address as Python's `ipaddress` reads it: hex groups of one to four digits,
 * at most one `::`, an optional dotted IPv4 tail as the very last part, eight groups in
 * all (fewer with `::`). No zone id: a `%` carries free text.
 */
function isIpv6(value: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(value) || value.split('::').length > 2) return false;
  const halves = value.split('::');
  const compressed = halves.length === 2;
  const parts = (half: string) => (half === '' ? [] : half.split(':'));
  const head = parts(halves[0]);
  const tail = compressed ? parts(halves[1]) : [];
  const all = [...head, ...tail];
  // The dotted IPv4 form may only end the address (not sit before a trailing `::`).
  const endsHere = !compressed || tail.length > 0;
  let groups = 0;
  for (let i = 0; i < all.length; i += 1) {
    const part = all[i];
    if (i === all.length - 1 && endsHere && part.includes('.')) {
      if (!IPV4.test(part)) return false;
      groups += 2;
    } else if (HEX_GROUP.test(part)) {
      groups += 1;
    } else {
      return false;
    }
  }
  return compressed ? groups <= 7 : groups === 8;
}

const VALID: Readonly<Record<AskEntityKind, (value: string) => boolean>> = {
  ip: (v) => IPV4.test(v) || isIpv6(v),
  hash: (v) => HASH.test(v),
  domain: (v) => DOMAIN.test(v),
  url: (v) => PRINTABLE_ASCII.test(v) && URL_SHAPE.test(v),
  email: (v) => EMAIL.test(v),
  host: (v) => IDENTIFIER.test(v) && LETTER_OR_DIGIT.test(v),
  user: (v) => IDENTIFIER.test(v) && LETTER_OR_DIGIT.test(v),
  rule: (v) => IDENTIFIER.test(v) && LETTER_OR_DIGIT.test(v),
  case: (v) => CASE_ID.test(v),
};

/** Whether `kind` is one of {@link ASK_ENTITY_KINDS}. */
export function isAskEntityKind(kind: unknown): kind is AskEntityKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(VALID, kind);
}

/**
 * The value a chip may ask about for `kind`, or `null` when it may not: an unknown kind,
 * not text, empty after trimming, longer than the kind allows, an invisible, control,
 * bidi or separator character, or not the kind's shape. Trimmed; never otherwise altered.
 */
export function askEntityValue(kind: unknown, raw: unknown): string | null {
  if (!isAskEntityKind(kind) || typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > KIND_MAX[kind] || hasInvisible(value)) return null;
  return VALID[kind](value) ? value : null;
}

/** "case-0042" already says it is a case; "demo-0042" does not. */
const NAMES_A_CASE = /^case/i;

/**
 * The chip's accessible name: what it does and what about ("Ask AI about 203.0.113.77",
 * "Ask AI about case demo-0042", "Ask AI about case-0042", "Ask AI about rule ssh-brute").
 * A very long value is shortened here only; the reference keeps the whole value.
 */
export function askAiLabel(kind: AskEntityKind, value: string): string {
  const shown = value.length > LABEL_VALUE_MAX ? `${value.slice(0, LABEL_VALUE_MAX - 1).trimEnd()}…` : value;
  if (kind === 'case') return NAMES_A_CASE.test(value) ? `Ask AI about ${shown}` : `Ask AI about case ${shown}`;
  if (kind === 'rule') return `Ask AI about rule ${shown}`;
  return `Ask AI about ${shown}`;
}

/* -------------------------------------------------------------------------- */
/* Kinds from entity types and value shapes.                                   */
/* -------------------------------------------------------------------------- */

/** Entity-type tokens (case entities, correlation keys, IOC types) → their kind. */
const TYPE_KINDS: Readonly<Record<string, AskEntityKind>> = {
  ip: 'ip',
  ipv4: 'ip',
  ipv6: 'ip',
  ip_address: 'ip',
  src_ip: 'ip',
  source_ip: 'ip',
  dst_ip: 'ip',
  destination_ip: 'ip',
  host: 'host',
  hostname: 'host',
  host_name: 'host',
  device: 'host',
  endpoint: 'host',
  user: 'user',
  username: 'user',
  user_name: 'user',
  account: 'user',
  file_hash: 'hash',
  hash: 'hash',
  md5: 'hash',
  sha1: 'hash',
  sha256: 'hash',
  domain: 'domain',
  fqdn: 'domain',
  url: 'url',
  uri: 'url',
  email: 'email',
  email_address: 'email',
  rule: 'rule',
  rule_id: 'rule',
};

/** The kind a value's SHAPE implies (IP, hash, URL, email, domain), else `null`. */
export function inferAskKind(raw: unknown): AskEntityKind | null {
  for (const kind of ['ip', 'hash', 'url', 'email', 'domain'] as const) {
    if (askEntityValue(kind, raw) !== null) return kind;
  }
  return null;
}

/**
 * The kind for an entity-type token (`ip`, `file_hash`, `sha256`, `hostname`…), falling
 * back to the value's shape when the type is missing or unknown. `null` when neither
 * says what the value is: a chip never guesses a kind it would then misname.
 */
export function askKindFor(type: unknown, value?: unknown): AskEntityKind | null {
  const token = typeof type === 'string' ? type.trim().toLowerCase().replace(/[\s.-]+/g, '_') : '';
  if (token && Object.prototype.hasOwnProperty.call(TYPE_KINDS, token)) return TYPE_KINDS[token];
  return value === undefined ? null : inferAskKind(value);
}

/**
 * A `type:value` entity key (the threat-context asset key, `ip:198.51.100.45`) split into
 * its type token and value when the prefix is a known entity type; otherwise the whole
 * text as the value with no type. An IPv6 value keeps its own colons (`ip:2001:db8::1`).
 */
export function splitEntityKey(raw: string): { type: string | null; value: string } {
  const match = /^([A-Za-z_]{2,24}):(.+)$/.exec(raw.trim());
  if (match && askKindFor(match[1]) !== null) return { type: match[1], value: match[2] };
  return { type: null, value: raw };
}

/**
 * What a chip asks about: the given `kind`, else the kind the entity `type` names, else
 * (no type) a `type:value` key's prefix or the value's own shape; and the value, which
 * must have that kind's shape ({@link askEntityValue}). `null` when there is no honest
 * reference: a host that forces a kind never turns prose into "an IP".
 */
export function resolveAskTarget(target: {
  kind?: AskEntityKind | null;
  type?: string | null;
  value: unknown;
}): AskEntityRef | null {
  if (typeof target.value !== 'string') return null;
  if (target.kind) {
    const value = askEntityValue(target.kind, target.value);
    return value === null ? null : { kind: target.kind, value };
  }
  // A `type:value` key loses its prefix when it names the same kind as the given type
  // (or there is no type): the question is about the value, not the key.
  const split = splitEntityKey(target.value);
  const key =
    !target.type || (split.type !== null && askKindFor(split.type) === askKindFor(target.type))
      ? split
      : { type: target.type, value: target.value };
  const kind = askKindFor(key.type, key.value);
  const value = kind ? askEntityValue(kind, key.value) : null;
  return kind && value !== null ? { kind, value } : null;
}

