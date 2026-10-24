/**
 * Round 13 polish, review of the third re-shoot (web): details measured on the live Demo.
 *
 * - One length rule for references: the server writes a reference of up to 27
 *   characters into a start question (`chat_starter_text.QUESTION_REF_WORD_MAX`), and the
 *   web keeps a word of up to 27 characters whole (`KEEP_TOKEN`), its punctuation not
 *   counted; a 26-character rule id with its "?" broke at its hyphen before ("sigma-" /
 *   "win-proc-creation-01?"). On a card or chip a kept token is an inline block no wider
 *   than its line, so it never runs past the card.
 * - A long custom case number in a case reference breaks where its line ends instead of
 *   running past the row (it was `nowrap` at any length).
 * - Chat KPI tile labels set proportional numerals, like the gauge label beside them.
 *
 * jsdom has no line layout: these pin the classes and spans; the wrapping was measured
 * live in Chromium (SPEC-chat §10.5, third re-shoot review).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AnnouncerProvider } from '@/soc/components/announcer';
import { TooltipProvider } from '@/ui/tooltip';

import AnswerBlocks from '../blocks/AnswerBlocks';
import { parseBlock, type AnswerBlock } from '../blocks/schema';
import { CaseStarterChips } from '../starters/CaseStarterChips';
import { StarterCard } from '../starters/StarterCard';
import { KEEP_TOKEN, LONG_TOKEN, softBreakLongTokens, tokenWord } from '../starters/soft-breaks';
import { CASE_NEEDS_PERSON, NEEDS_HUMAN, makeInfo } from '../starters/__tests__/fixtures';
import type { ChatStartersController } from '../starters/useChatStarters';

const STARTER_TEXT_PY = readFileSync(resolve(__dirname, '../../../../../backend/app/agents/chat_starter_text.py'), 'utf8');

function textOf(node: React.ReactNode): HTMLElement {
  return render(<span>{node}</span>).container.firstElementChild as HTMLElement;
}

const kept = (el: Element) => Array.from(el.querySelectorAll('[data-kept-token]'), (n) => n.textContent);
const long = (el: Element) => Array.from(el.querySelectorAll('[data-long-token]'), (n) => n.textContent);

function show(blocks: AnswerBlock[]) {
  return render(
    <AnnouncerProvider>
      <TooltipProvider>
        <AnswerBlocks blocks={blocks} messageId="m1" />
      </TooltipProvider>
    </AnnouncerProvider>,
  );
}

describe('one length rule for references', () => {
  it('keeps the same limit as the server writes into a start question', () => {
    const match = /^QUESTION_REF_WORD_MAX = (\d+)$/m.exec(STARTER_TEXT_PY);
    expect(match).not.toBeNull();
    expect(KEEP_TOKEN).toBe(Number(match![1]));
    // No length between the two limits is left to the browser's hyphen break.
    expect(LONG_TOKEN).toBe(KEEP_TOKEN + 1);
  });

  it('measures a token by its word, the punctuation around it not counted', () => {
    expect(tokenWord('sigma-win-proc-creation-01?')).toBe('sigma-win-proc-creation-01');
    expect(tokenWord('(CASE-000089),')).toBe('CASE-000089');
    expect(tokenWord('vpn-gw-2.')).toBe('vpn-gw-2');
    expect(tokenWord('?')).toBe('?');
  });

  it('keeps a 25 to 27 character rule id whole with its question mark', () => {
    const question = 'Why did detection rule sigma-win-proc-creation-01 create 9 cases, and is sigma-win-proc-creation-01?';
    const el = textOf(softBreakLongTokens(question));
    expect(el.textContent).toBe(question);
    expect(kept(el)).toEqual(['sigma-win-proc-creation-01', 'sigma-win-proc-creation-01?']);
    expect(long(el)).toEqual([]);
    // A word of exactly 27 characters with its "?" (28 in all) is still kept whole.
    const word27 = `${'a'.repeat(13)}-${'b'.repeat(13)}`;
    expect(word27).toHaveLength(KEEP_TOKEN);
    expect(kept(textOf(softBreakLongTokens(`Is ${word27}?`)))).toEqual([`${word27}?`]);
    // One more character and the word may break anywhere but at its ends.
    const word28 = `${word27}c`;
    const over = textOf(softBreakLongTokens(`Is ${word28}?`));
    expect(kept(over)).toEqual([]);
    expect(long(over)).toEqual([`${word28}?`]);
  });

  it('keeps a token as an inline block no wider than its line on cards and chips (`fit`), nowrap elsewhere', () => {
    const fit = textOf(softBreakLongTokens('What links the cases that include CASE-000082?', { fit: true }));
    const token = fit.querySelector('[data-kept-token]')!;
    expect(token).toHaveTextContent('CASE-000082?');
    expect(token).toHaveClass('inline-block', 'max-w-full');
    expect(token).not.toHaveClass('whitespace-nowrap');
    const plain = textOf(softBreakLongTokens('What links the cases that include CASE-000082?'));
    expect(plain.querySelector('[data-kept-token]')).toHaveClass('whitespace-nowrap');
  });

  it('sets a start card question and its reason with `fit`', () => {
    const prompt = 'Why did detection rule sigma-win-proc-creation-01 create 9 of the 30 cases in the last 24 hours, and why?';
    render(
      <TooltipProvider>
        <StarterCard starter={{ ...NEEDS_HUMAN, prompt, reason: '30% of new cases' }} tabIndex={0} onActivate={vi.fn()} onHide={vi.fn()} />
      </TooltipProvider>,
    );
    const question = document.querySelector('[data-starter] [id$="-q"]') as HTMLElement;
    expect(question.textContent).toBe(prompt);
    const token = question.querySelector('[data-kept-token]') as HTMLElement;
    expect(token.textContent).toBe('sigma-win-proc-creation-01');
    expect(token).toHaveClass('inline-block', 'max-w-full');
  });

  it('sets a Case Manager chip with `fit`', () => {
    const starters: ChatStartersController = {
      info: makeInfo({
        surface: 'case',
        starters: [{ ...CASE_NEEDS_PERSON, prompt: 'Which LP-ES-RISK-1001-WINDOWS alerts belong to this case?' }],
      }),
      loading: false,
      error: null,
      retry: vi.fn(),
      setHeld: vi.fn(),
    };
    render(<CaseStarterChips caseId="case-1" starters={starters} onSend={vi.fn()} />);
    const chips = screen.getByTestId('case-starter-chips');
    const token = chips.querySelector('[data-kept-token]') as HTMLElement;
    expect(token.textContent).toBe('LP-ES-RISK-1001-WINDOWS');
    expect(token).toHaveClass('inline-block', 'max-w-full');
  });
});

describe('case numbers in case references', () => {
  const caseList = (caseNumber: string) =>
    parseBlock({
      id: 'cl',
      type: 'case_list',
      provenance: 'code',
      artifact_kind: 'case_list',
      items: [{ case_id: 'case-6b22d1999bf94f3a91c10ab2a23e6e7c', case_number: caseNumber, title: 'ip:203.0.113.77 · LP-ES-RISK-1001' }],
    });

  it('keeps a short number whole and lets a long custom number break where its line ends', () => {
    const { unmount } = show([caseList('CASE-000078')]);
    let number = screen.getByTestId('block-case-list').querySelector('[data-case-ref="number"]') as HTMLElement;
    expect(number).not.toHaveClass('whitespace-nowrap');
    expect(kept(number)).toEqual(['CASE-000078']);
    expect(number).toHaveAttribute('title', 'case-6b22d1999bf94f3a91c10ab2a23e6e7c');
    unmount();

    // A 41-character number from an operator template: it ran to 347 px of a 350 px row
    // at 390, and anything longer overflowed.
    const longNumber = 'LUMENPAY-SOC-PRODUCTION-2026-10-23-000089';
    show([caseList(longNumber)]);
    number = screen.getByTestId('block-case-list').querySelector('[data-case-ref="number"]') as HTMLElement;
    expect(number).not.toHaveClass('whitespace-nowrap');
    expect(number.textContent).toBe(longNumber);
    expect(long(number)).toEqual([longNumber]);
    expect(number.querySelector('[data-long-token]')).toHaveClass('break-all');
  });
});

describe('chat KPI tile labels', () => {
  it('sets a tile label with proportional numerals, like the gauge label beside it, and keeps the figures tabular', () => {
    show([
      parseBlock({
        id: 'k',
        type: 'kpi_group',
        title: 'Key metrics',
        provenance: 'code',
        artifact_kind: 'kpi_group',
        items: [
          { key: 'fp', label: 'False-positive rate', value: 12, unit: 'percent' },
          { key: 'ari', label: 'Active risk index', value: 48, unit: 'score', display: 'gauge' },
        ],
      }),
    ]);
    const tile = screen.getByText('False-positive rate');
    expect(tile.closest('[role="listitem"]')).toHaveClass('proportional-nums');
    // The numeral keeps its own tabular figures.
    const cell = tile.closest('[role="listitem"]') as HTMLElement;
    expect(cell.querySelector('.tabular-nums')).not.toBeNull();
    // The gauge label beside it was already proportional.
    expect(screen.getByText('Active risk index')).toHaveClass('proportional-nums');
  });
});
