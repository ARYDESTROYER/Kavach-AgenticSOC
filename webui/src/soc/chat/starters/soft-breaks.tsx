/**
 * Long unbreakable tokens in starter text (Round 13 polish, re-shoot PW2-5): a starter
 * question can carry an id, a hash or a host name with no space in it
 * ("campaign-4039d3c5ab857211899383250c57b5dc?"). `overflow-wrap: break-word` only cuts
 * such a token where a line overflows, so the token first moved to a line of its own and
 * then left its last one or two characters ("c?") alone on a third line, which also made
 * the card (and the start grid) taller than its skeleton.
 *
 * A token of {@link LONG_TOKEN} characters or more is set `word-break: break-all`, so it
 * starts on the line it belongs to and breaks where that line ends, like any wrapped
 * text. Its first {@link HEAD_KEEP} and last {@link TAIL_KEEP} characters (trailing
 * punctuation included) are `white-space: nowrap`, so no line starts or ends with a one or
 * two character scrap of the token. Ordinary words are left alone.
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

/** `text` with its long tokens breakable; the string itself when it has none. */
export function softBreakLongTokens(text: string): React.ReactNode {
  const parts = text.split(/(\s+)/);
  if (!parts.some(isLongToken)) return text;
  const out: React.ReactNode[] = [];
  let plain = '';
  parts.forEach((part, index) => {
    if (!isLongToken(part)) {
      plain += part;
      return;
    }
    if (plain) out.push(plain);
    plain = '';
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

function isLongToken(part: string): boolean {
  return part.length >= LONG_TOKEN && !/\s/.test(part);
}
