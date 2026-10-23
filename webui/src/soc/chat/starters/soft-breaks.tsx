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
 * "000089?", "LP-" / "ES-RISK-1001"). A token of at most {@link KEEP_TOKEN} characters
 * that a browser could break inside (a hyphen, a dash or a slash) is `nowrap`, with its
 * punctuation ("CASE-000089?" stays whole), so the sentence still wraps between words
 * and the token moves to the next line whole. `keepShortTokens` with `all` keeps EVERY
 * short token whole: for text inside `word-break: break-all` (an InlineCode table cell,
 * where "T1078" broke into "T107" / "8"), where a token needs no hyphen to be cut.
 * Tokens between the two lengths are left to the browser. Ordinary words are left
 * alone, and text without such a token is returned as the same string.
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
 * The longest token kept on one line: a case number ("CASE-000089?"), a technique id
 * ("T1059.001"), a short rule id ("LP-ES-RISK-1001"), with its punctuation. At 24
 * characters it fits the narrowest line it is set on (a 390 px phone card or chip).
 */
export const KEEP_TOKEN = 24;

/** Characters a browser breaks a word after: hyphens, dashes and a slash. */
const INNER_BREAK = /[-/‐‒-―]/u;

export interface TokenBreakOptions {
  /** Keep every short token whole, not only one with a hyphen (text set `break-all`). */
  all?: boolean;
  /**
   * Set long tokens `break-all` with kept ends (default). Off where the text already
   * breaks anywhere (an InlineCode cell) or a table cell may simply grow its column.
   */
  breakLong?: boolean;
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
        <span key={index} className="whitespace-nowrap" data-kept-token="">
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

/** The same rule under the name the block renderers use (`all` for `break-all` text). */
export const keepShortTokens = softBreakLongTokens;

function tokenKind(part: string, { all = false, breakLong = true }: TokenBreakOptions): 'keep' | 'long' | null {
  if (!part || /\s/.test(part)) return null;
  // Code points, like the spans: an emoji counts once.
  const length = Array.from(part).length;
  if (length >= LONG_TOKEN) return breakLong ? 'long' : null;
  if (length > KEEP_TOKEN || length < 2) return null;
  return all || INNER_BREAK.test(part.slice(0, -1)) ? 'keep' : null;
}
