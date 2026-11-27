/**
 * Where a reference token may break in chat text (Round 13 polish).
 *
 * Long tokens (re-shoot PW2-5): a starter question can carry an id, a hash or a host
 * name with no space in it ("campaign-4039d3c5ab857211899383250c57b5dc?").
 * `overflow-wrap: break-word` only cuts such a token where a line overflows, so the token
 * first moved to a line of its own and then left its last one or two characters ("c?")
 * alone on a third line, which also made the card (and the start grid) taller than its
 * skeleton. A token of {@link LONG_TOKEN} characters or more is set `word-break:
 * break-all`, so it starts on the line it belongs to and breaks where that line ends,
 * like any wrapped text. Its first {@link HEAD_KEEP} and last {@link TAIL_KEEP}
 * characters (trailing punctuation included) are `white-space: nowrap`, so no line
 * starts or ends with a one or two character scrap of the token.
 *
 * Short reference tokens (third re-shoot, PW4-1): a browser breaks a word after its
 * hyphen, so a case number, a technique id or a rule id split across two lines ("CASE-" /
 * "000089?", "LP-" / "ES-RISK-1001"). A token whose word is at most {@link KEEP_TOKEN}
 * characters and that a browser could break inside (a hyphen, a dash or a slash) is kept
 * whole, with its punctuation ("CASE-000089?" stays whole), so the sentence still wraps
 * between words and the token moves to the next line whole. With `all` it keeps EVERY
 * short token whole: for text inside `word-break: break-all` (an InlineCode table cell,
 * where "T1078" broke into "T107" / "8"), where a token needs no hyphen to be cut.
 *
 * One length rule (third re-shoot review): a token's length is that of its WORD, the punctuation
 * around it not counted ("sigma-win-proc-creation-01?" is 26), and the two limits meet:
 * a word of up to {@link KEEP_TOKEN} (27) characters is kept whole and one of
 * {@link LONG_TOKEN} (28) or more breaks anywhere but at its ends. The server writes a
 * reference into a start question only when it is at most 27 characters
 * (`chat_starter_text.QUESTION_REF_WORD_MAX`), so every reference a card names is whole.
 * Before, a 25 to 27 character rule id was left to the browser and broke at its hyphen.
 *
 * How a token is kept: `nowrap` by default, so a table cell's column grows to the whole
 * token and a link's underline runs under it. Where the text is prose on a card or chip
 * (`fit`), a kept token is an inline block no wider than its line instead: it moves to the
 * next line whole when it fits there, and only a token wider than the whole line (a 27
 * character id of capitals on a narrow phone) wraps inside, at its hyphens, rather than
 * running past the card. Ordinary words are left alone, and text without such a token is
 * returned as the same string.
 *
 * CSS only, never a `<wbr>` or a zero-width space: Chromium reads a `<wbr>` as a space in
 * the accessible name ("campaign-40 39…"), and an invisible character would travel with a
 * copy. The value stays React text (#9).
 */
import * as React from 'react';

/**
 * The shortest token (no white space) that may break between any two characters: ids and
 * hashes (an MD5 is 32, a campaign id 41 characters). Shorter words, rule names such as
 * "demo_noisy_scanner" included, wrap whole, as they fit on a card line.
 */
export const LONG_TOKEN = 28;
/** Characters kept together at the start of a long token. */
export const HEAD_KEEP = 4;
/** Characters kept together at the end of a long token (its trailing punctuation included). */
export const TAIL_KEEP = 6;
/**
 * The longest word kept on one line, its punctuation not counted: a case number
 * ("CASE-000089?"), a technique id ("T1059.001"), a rule id ("sigma-win-proc-creation-01").
 * One less than {@link LONG_TOKEN}, so every token is either kept or breakable, and the
 * same limit as the server's `QUESTION_REF_WORD_MAX`. Measured live at 390 px: a 27
 * character id of capitals with its "?" is 226 to 258 px on a start card's 262 px line.
 */
export const KEEP_TOKEN = LONG_TOKEN - 1;

/** Characters a browser breaks a word after: hyphens, dashes and a slash. */
const INNER_BREAK = /[-/‐‒-―]/u;
/** Punctuation before a word ("(CASE-000089") and after it ("CASE-000089?", "vpn-gw-2,"). */
const LEADING_PUNCT = /^[(\[{"'‘“«]+/u;
const TRAILING_PUNCT = /[?!.,;:)\]}"'’”»…]+$/u;

export interface TokenBreakOptions {
  /** Keep every short token whole, not only one with a hyphen (text set `break-all`). */
  all?: boolean;
  /**
   * Set long tokens `break-all` with kept ends (default). Off where the text already
   * breaks anywhere (an InlineCode cell) or a table cell may simply grow its column.
   */
  breakLong?: boolean;
  /**
   * Prose on a card or chip: keep a short token as an inline block no wider than its line
   * (whole when it fits, wrapped inside only when it is wider than the whole line) instead
   * of `nowrap`. Not for a table cell (its column must grow to the whole token) or a link
   * (an underline does not reach into an inline block).
   */
  fit?: boolean;
}

/**
 * `text` with its reference tokens kept whole and its long tokens breakable; the string
 * itself when it has neither.
 */
export function softBreakLongTokens(text: string, options: TokenBreakOptions = {}): React.ReactNode {
  const parts = text.split(/(\s+)/);
  const kind = parts.map((part) => tokenKind(part, options));
  if (!kind.some(Boolean)) return text;
  const out: React.ReactNode[] = [];
  let plain = '';
  parts.forEach((part, index) => {
    const k = kind[index];
    if (!k) {
      plain += part;
      return;
    }
    if (plain) out.push(plain);
    plain = '';
    if (k === 'keep') {
      out.push(
        <span key={index} className={options.fit ? 'inline-block max-w-full' : 'whitespace-nowrap'} data-kept-token="">
          {part}
        </span>,
      );
      return;
    }
    // Code points, so a surrogate pair is never split between the spans.
    const chars = Array.from(part);
    out.push(
      <span key={index} className="break-all" data-long-token="">
        <span className="whitespace-nowrap">{chars.slice(0, HEAD_KEEP).join('')}</span>
        {chars.slice(HEAD_KEEP, chars.length - TAIL_KEEP).join('')}
        <span className="whitespace-nowrap">{chars.slice(chars.length - TAIL_KEEP).join('')}</span>
      </span>,
    );
  });
  if (plain) out.push(plain);
  return out;
}

/** A token's word: the token without the punctuation around it (all of it when that is all it is). */
export function tokenWord(part: string): string {
  return part.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '') || part;
}

function tokenKind(part: string, { all = false, breakLong = true }: TokenBreakOptions): 'keep' | 'long' | null {
  if (!part || /\s/.test(part)) return null;
  const word = tokenWord(part);
  // Code points, like the spans: an emoji counts once.
  const length = Array.from(word).length;
  if (length >= LONG_TOKEN) return breakLong ? 'long' : null;
  if (Array.from(part).length < 2) return null;
  // A hyphen that ends the word is no break inside it.
  return all || INNER_BREAK.test(word.slice(0, -1)) ? 'keep' : null;
}
