/**
 * Long unbreakable tokens in starter text (Round 13 polish, re-shoot PW2-5): a campaign id
 * or a hash may break between any two characters (`break-all`) so it breaks where its line
 * ends, with its first and last characters kept together (`whitespace-nowrap`), so no line
 * holds a one or two character scrap ("c?"). Ordinary words are untouched, and the text
 * and the accessible name stay exactly the server's string (no `<wbr>`, which Chromium
 * reads as a space in the name, and no invisible character).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';

import { StarterCard } from '../StarterCard';
import { HEAD_KEEP, LONG_TOKEN, TAIL_KEEP, softBreakLongTokens } from '../soft-breaks';
import { NEEDS_HUMAN } from './fixtures';

const CAMPAIGN_QUESTION = 'What links the 5 cases in campaign-4039d3c5ab857211899383250c57b5dc?';
const TOKEN = 'campaign-4039d3c5ab857211899383250c57b5dc?';

function renderText(text: string): HTMLElement {
  render(<span data-testid="t">{softBreakLongTokens(text)}</span>);
  return screen.getByTestId('t');
}

describe('softBreakLongTokens', () => {
  it('leaves text without a long token as the same string', () => {
    const text = 'Which of the 45 cases opened since 04:19 need attention first?';
    expect(softBreakLongTokens(text)).toBe(text);
    expect(softBreakLongTokens('')).toBe('');
    // A rule name fits on a card line: it wraps whole, never broken inside.
    const rule = 'Why did detection rule demo_noisy_scanner create 30 of the 50 cases in the last 24 hours?';
    expect(softBreakLongTokens(rule)).toBe(rule);
  });

  it('lets a long token break anywhere but at its ends', () => {
    const el = renderText(CAMPAIGN_QUESTION);
    expect(el.textContent).toBe(CAMPAIGN_QUESTION);
    const tokens = el.querySelectorAll('[data-long-token]');
    expect(tokens).toHaveLength(1);
    const token = tokens[0] as HTMLElement;
    expect(token).toHaveClass('break-all');
    expect(token.textContent).toBe(TOKEN);
    const kept = Array.from(token.querySelectorAll('.whitespace-nowrap'), (n) => n.textContent);
    // The head and the tail (its "?" included) never break.
    expect(kept).toEqual([TOKEN.slice(0, HEAD_KEEP), TOKEN.slice(-TAIL_KEEP)]);
    // The words before the token are one plain text run: no break inside them.
    expect(el.childNodes).toHaveLength(2);
    expect(el.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.firstChild?.textContent).toBe('What links the 5 cases in ');
    expect(el.querySelector('wbr')).toBeNull();
    expect(el.textContent).not.toMatch(/[\u200B\u00AD]/);
  });

  it('only touches tokens of LONG_TOKEN characters or more, and keeps the white space', () => {
    const short = 'x'.repeat(LONG_TOKEN - 1);
    const long = 'y'.repeat(LONG_TOKEN);
    const el = renderText(`Hunt  ${short} and ${long} now`);
    expect(el.textContent).toBe(`Hunt  ${short} and ${long} now`);
    expect(Array.from(el.querySelectorAll('[data-long-token]'), (n) => n.textContent)).toEqual([long]);
  });

  it('never splits a surrogate pair between the spans', () => {
    const token = `${'a'.repeat(2)}😀${'b'.repeat(25)}😀${'c'.repeat(4)}`;
    const el = renderText(token);
    expect(el.textContent).toBe(token);
    const kept = Array.from(el.querySelectorAll('.whitespace-nowrap'), (n) => n.textContent ?? '');
    expect(kept).toEqual([`aa😀b`, `b😀cccc`]);
  });
});

describe('a starter card with a long id', () => {
  it('keeps the exact question as the text that names the card', () => {
    render(
      <TooltipProvider>
        <StarterCard starter={{ ...NEEDS_HUMAN, prompt: CAMPAIGN_QUESTION, reason: 'Opened 2 hours ago' }} tabIndex={0} onActivate={vi.fn()} onHide={vi.fn()} />
      </TooltipProvider>,
    );
    const hide = screen.getByRole('button', { name: `Hide for a day: ${CAMPAIGN_QUESTION}` });
    const card = hide.parentElement!.querySelector<HTMLButtonElement>('button[data-starter]')!;
    expect(card).toHaveAccessibleDescription('Opened 2 hours ago');
    // The card is named by its question element (`aria-labelledby`), whose text is the
    // exact question. jsdom gives a <span> no default `display`, so its own name
    // computation would add spaces around the inline spans; Chromium names the card
    // with the exact question (checked live through the accessibility tree).
    const label = document.getElementById(card.getAttribute('aria-labelledby')!)!;
    expect(label.textContent).toBe(CAMPAIGN_QUESTION);
    expect(label.querySelector('[data-long-token]')).toHaveTextContent(TOKEN);
  });
});
