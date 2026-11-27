/**
 * Round 14 (SPEC §4.6.3, §4.6.5; the FX2b contract): a case card's Rules fact lists its
 * rules one by one (`facts[].items`), each with the rule sheet it opens over the case's
 * own window. Pinned here:
 *
 * - parsing mirrors `blocks.py` `EntityFact.items`: at most five values, only a valid
 *   `rule` ref kept as a destination (any other, or a malformed one, leaves plain text),
 *   none on a model-made (`ai`) block, and no `items` at all on an older answer;
 * - the card names each rule as a `RuleLink` in order, comma separated, opening the rule
 *   sheet on the case's window, "From CASE-000214" when the card names its case; a value
 *   without a ref stays plain untrusted text; following a link in the sheet remembers the
 *   answer ("Back to answer");
 * - print and every export keep the fact's plain text, never a link;
 * - no rule value is ever markup.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { summaryMock, logsMock } = vi.hoisted(() => ({ summaryMock: vi.fn(), logsMock: vi.fn() }));

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => () => undefined }));
vi.mock('@/lib/api-rules', () => ({ getRuleSummary: summaryMock }));
vi.mock('@/soc/UnifiedLogs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/soc/UnifiedLogs.api')>()),
  fetchUnifiedLogs: logsMock,
}));
vi.mock('@/soc/auth', () => {
  const auth = () => ({ username: 'analyst', hasPermission: () => true });
  return { useAuth: auth, useOptionalAuth: auth };
});

import type { ChatConversation, Report, ReportItem } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { answerOrigin, clearAnswerOrigin } from '@/soc/answer-origin';
import { getRuleSheetRequest, resetRuleSheetStoreForTests } from '@/soc/components/rule-sheet-store';
import { latestFixture, summaryFixture } from '@/soc/components/__tests__/rule-sheet.fixtures';
import { conversationToMarkdown } from '../../report/export/conversation';
import { reportToMarkdown } from '../../report/export/markdown';
import { documentNodes, type TableNode } from '../../report/export/walker';
import { buildReportDoc } from '../../report/model';
import AnswerBlocks from '../AnswerBlocks';
import { BlockBody } from '../BlockCard';
import { blockTabular, toCSV } from '../export-helpers';
import { ENTITY_FACT_ITEMS, parseBlock } from '../schema';
import type { AnswerBlock, EntityBlock } from '../schema';

const SSH = 'Fehlgeschlagene Anmeldung über SSH';
const LONG = `${'x'.repeat(300)} kept as text`;
const FROM = '2026-10-20T08:14:03Z';
const TO = '2026-10-21T09:30:00.250Z';
const WINDOW = { from: FROM, to: TO };
const ruleRef = (rule: string) => ({ page: 'rule', opts: { rule, from: FROM, to: TO } });
const RULES_TEXT = `${SSH}, web_scan, ${LONG}`;

/** The Rules fact as `get_case` builds it: one value per rule, a ref where one can carry it. */
const rulesFact = (items: unknown[] = [{ value: SSH, drill: ruleRef(SSH) }, { value: 'web_scan', drill: ruleRef('web_scan') }, { value: LONG }]) => ({
  label: 'Rules',
  value: RULES_TEXT,
  untrusted: true,
  items,
});

function caseCard({ facts, provenance = 'code' }: { facts?: unknown[]; provenance?: string } = {}): Record<string, unknown> {
  return {
    id: 'case-card',
    type: 'entity',
    title: 'Case entity',
    provenance,
    artifact_kind: 'entity',
    allowed_views: ['entity'],
    entity: { kind: 'ip', value: '203.0.113.9' },
    facts: facts ?? [{ label: 'Case', value: 'CASE-000214' }, { label: 'Status', value: 'Escalated' }, rulesFact()],
    reputation: [],
    counts: [],
    related_cases: [],
  };
}

const parsed = (raw: Record<string, unknown>) => parseBlock(raw) as EntityBlock;
const rulesOf = (block: EntityBlock) => block.facts.find((f) => f.label === 'Rules')!;

function show(block: AnswerBlock, props: Partial<React.ComponentProps<typeof AnswerBlocks>> = {}) {
  return render(
    <TooltipProvider>
      <AnswerBlocks blocks={[block]} messageId="m1" {...props} />
    </TooltipProvider>,
  );
}

/** The `dd` of the card's Rules fact. */
function rulesValue(): HTMLElement {
  const card = screen.getByTestId('block-entity');
  const term = within(card).getByText('Rules', { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
}

async function settleHash(hash: string): Promise<void> {
  if (window.location.hash !== hash) {
    const changed = new Promise<void>((resolve) => window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.location.hash = hash;
    await changed;
  }
}

beforeAll(async () => {
  // The sheet chunk is cached after the first open in the app; load it up front here.
  await import('@/soc/components/RuleSheet');
});

beforeEach(() => {
  summaryMock.mockImplementation(async ({ rule }: { rule: string }) => summaryFixture({ rule }));
  logsMock.mockResolvedValue(latestFixture());
});

afterEach(() => {
  act(() => resetRuleSheetStoreForTests());
  summaryMock.mockReset();
  logsMock.mockReset();
});

describe('parsing a fact listed one by one', () => {
  it('keeps each value with its rule sheet, and a value without one as plain text', () => {
    const fact = rulesOf(parsed(caseCard()));
    expect(fact.value).toBe(RULES_TEXT);
    expect(fact.items).toEqual([
      { value: SSH, drill: ruleRef(SSH) },
      { value: 'web_scan', drill: ruleRef('web_scan') },
      { value: LONG },
    ]);
  });

  it('keeps an older answer (no items) and an empty list as the plain fact', () => {
    const old = parsed(caseCard({ facts: [{ label: 'Rules', value: RULES_TEXT, untrusted: true }] }));
    expect(rulesOf(old)).toEqual({ label: 'Rules', value: RULES_TEXT, untrusted: true });
    expect(rulesOf(parsed(caseCard({ facts: [rulesFact([])] }))).items).toBeUndefined();
    expect(rulesOf(parsed(caseCard({ facts: [rulesFact('a, b' as unknown as unknown[])] }))).items).toBeUndefined();
  });

  it(`lists at most ${ENTITY_FACT_ITEMS} values, as blocks.py does`, () => {
    const many = Array.from({ length: ENTITY_FACT_ITEMS + 2 }, (_, i) => ({ value: `rule-${i}`, drill: ruleRef(`rule-${i}`) }));
    const items = rulesOf(parsed(caseCard({ facts: [rulesFact(many)] }))).items!;
    expect(items.map((i) => i.value)).toEqual(['rule-0', 'rule-1', 'rule-2', 'rule-3', 'rule-4']);
  });

  it('keeps only a valid rule ref: a route, an unknown opt or a value outside the rule grammar leaves plain text', () => {
    const items = rulesOf(
      parsed(
        caseCard({
          facts: [
            rulesFact([
              { value: 'routed', drill: { page: 'logs', opts: { rule: 'routed', from: FROM, to: TO } } },
              { value: 'unknown opt', drill: { page: 'rule', opts: { rule: 'unknown opt', caseId: 'case-1' } } },
              { value: 'bell', drill: ruleRef('bell\u0007') },
              { value: 'bad window', drill: { page: 'rule', opts: { rule: 'bad window', from: 'yesterday' } } },
              { value: 'ok', drill: ruleRef('ok') },
            ]),
          ],
        }),
      ),
    ).items!;
    expect(items).toEqual([{ value: 'routed' }, { value: 'unknown opt' }, { value: 'bell' }, { value: 'bad window' }, { value: 'ok', drill: ruleRef('ok') }]);
  });

  it('never keeps a destination on a model-made card (G5)', () => {
    const block = parsed({ ...caseCard(), title: undefined, caption: 'From the model', provenance: 'ai' });
    const items = rulesOf(block).items!;
    expect(items.map((i) => i.value)).toEqual([SSH, 'web_scan', LONG]);
    expect(items.some((i) => 'drill' in i)).toBe(false);
  });

  it('drops a value that is not an object or shows nothing, and names a blank linked value by its rule', () => {
    const items = rulesOf(
      parsed(caseCard({ facts: [rulesFact(['bare string', null, { value: '' }, { value: '', drill: ruleRef('named by rule') }, { drill: ruleRef('no value') }])] })),
    ).items!;
    expect(items).toEqual([{ value: 'named by rule', drill: ruleRef('named by rule') }]);
  });
});

describe('the case card names each rule as a link to its rule sheet', () => {
  it('lists the rules in order, comma separated, a value without a ref as plain text', () => {
    show(parsed(caseCard()));
    const value = rulesValue();
    expect(value).toHaveTextContent(RULES_TEXT);
    const links = within(value).getAllByRole('button', { name: /^Open rule / });
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([`Open rule ${SSH}`, 'Open rule web_scan']);
    // The untrusted fact keeps its mono cue; the value without a ref is not a control.
    expect(value.querySelector('[data-fact-items]')).toHaveClass('font-mono');
    expect(within(value).getByText(LONG).closest('button')).toBeNull();
  });

  it('opens the rule sheet on the case window, from the case the card names', async () => {
    const user = userEvent.setup();
    show(parsed(caseCard()));
    const link = within(rulesValue()).getByRole('button', { name: `Open rule ${SSH}` });
    await user.click(link);
    expect(getRuleSheetRequest()).toMatchObject({ rule: SSH, window: WINDOW, origin: 'CASE-000214' });
    expect(await screen.findByRole('dialog')).toHaveAccessibleDescription('From CASE-000214');
    expect(link).toHaveAttribute('aria-current', 'true');
    // The sheet reads the rule's picture over exactly that window.
    await waitFor(() =>
      expect(summaryMock).toHaveBeenCalledWith(expect.objectContaining({ rule: SSH, window: `${FROM}..${TO}` }), expect.anything()),
    );
  });

  it.each([
    ['names no case', [rulesFact()]],
    ['names its case by title (source text)', [{ label: 'Case', value: 'Brute force on web01', untrusted: true }, rulesFact()]],
    ['holds a stored internal id', [{ label: 'Case', value: 'case-95928c4b1e2d4f6a8b0c1d2e3f405162' }, rulesFact()]],
  ])('opens the sheet "From your answer" when the card %s', async (_name, facts) => {
    const user = userEvent.setup();
    show(parsed(caseCard({ facts })));
    await user.click(within(rulesValue()).getByRole('button', { name: 'Open rule web_scan' }));
    expect(getRuleSheetRequest()).toMatchObject({ rule: 'web_scan', window: WINDOW, origin: 'your answer' });
  });

  it('shows the plain fact on a model-made card and on an older answer', () => {
    const { unmount } = show(parsed({ ...caseCard(), caption: 'From the model', provenance: 'ai' }));
    expect(within(rulesValue()).queryByRole('button')).toBeNull();
    expect(rulesValue()).toHaveTextContent(RULES_TEXT);
    unmount();
    show(parsed(caseCard({ facts: [{ label: 'Case', value: 'CASE-000214' }, { label: 'Rules', value: RULES_TEXT, untrusted: true }] })));
    expect(within(rulesValue()).queryByRole('button')).toBeNull();
    expect(within(rulesValue()).getByText(RULES_TEXT)).toHaveClass('font-mono');
  });

  it('prints the plain text, never a control', () => {
    render(<BlockBody block={parsed(caseCard())} title="Case entity" index={0} staticMode />);
    expect(screen.queryByRole('button', { name: /^Open rule / })).toBeNull();
    expect(rulesValue()).toHaveTextContent(RULES_TEXT);
  });

  it('never renders a rule value as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = show(parsed(caseCard({ facts: [rulesFact([{ value: hostile, drill: ruleRef(hostile) }, { value: '<b>plain</b>' }])] })));
    expect(container.querySelector('img, b')).toBeNull();
    expect(within(rulesValue()).getByRole('button', { name: `Open rule ${hostile}` })).toHaveTextContent(hostile);
    expect(rulesValue()).toHaveTextContent(`${hostile}, <b>plain</b>`);
  });
});

describe('Back to answer from a case card rule', () => {
  beforeEach(async () => {
    clearAnswerOrigin();
    await settleHash('#/chat');
  });

  afterEach(async () => {
    clearAnswerOrigin();
    await settleHash('');
  });

  it('remembers the saved answer when a link in the rule sheet leaves it, and nothing for an open and close', async () => {
    const user = userEvent.setup();
    show(parsed(caseCard()), { answerLocation: { conversationId: 'c-2', messageId: 'm1' } });
    await user.click(within(rulesValue()).getByRole('button', { name: 'Open rule web_scan' }));
    const logs = await screen.findByTestId('rule-open-logs');
    expect(answerOrigin()).toBeNull();
    await user.click(logs);
    expect(answerOrigin()).toEqual({ hash: '#/chat?conversationId=c-2&messageId=m1', label: 'Back to answer' });
  });
});

describe('the exports keep the fact as plain text', () => {
  const SCOPE = { window: 'last 7 days', sources: [], generated_by: 'demo-chat', app_version: '0.1.13', demo: true };
  const NOW = new Date('2026-10-22T10:00:00Z');

  function report(): Report {
    const item = {
      id: 'it-case',
      kind: 'section',
      block: { title: 'Case', blocks: [caseCard()], truncated: false },
      note: null,
      source: { conversation_id: 'chat-1', message_id: 'msg-2', block_id: null },
      scope: SCOPE,
      added_at: '2026-10-22T09:00:00Z',
    } as ReportItem;
    return {
      id: 'rep-case',
      owner: 'Admin',
      title: 'Case review',
      template: 'executive',
      conversation_id: 'chat-1',
      items: [item],
      summary: null,
      created_at: '2026-10-22T09:00:00Z',
      updated_at: '2026-10-22T09:00:00Z',
      version: 1,
    } as Report;
  }

  function conversation(): ChatConversation {
    return {
      id: 'chat-1',
      title: 'Case review',
      created_at: '2026-10-22T09:00:00Z',
      updated_at: '2026-10-22T09:00:05Z',
      message_count: 2,
      messages: [
        { id: 'msg-1', role: 'user', content: 'Tell me about CASE-000214', created_at: '2026-10-22T09:00:00Z' },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'CASE-000214 is escalated.',
          created_at: '2026-10-22T09:00:05Z',
          response: { answer: 'CASE-000214 is escalated.', blocks: [caseCard()], message_id: 'msg-2' },
        },
      ],
    } as unknown as ChatConversation;
  }

  it('CSV and Copy data: one Rules row holding the whole value', () => {
    const tab = blockTabular(parsed(caseCard()))!;
    expect(tab.rows).toContainEqual(['Rules', RULES_TEXT]);
    const csv = toCSV(tab);
    expect(csv).toContain('Rules');
    expect(csv).toContain(SSH);
    expect(csv).not.toContain('#/');
  });

  it('the document nodes (Markdown, HTML, Word and Excel) and the Markdown file', () => {
    const doc = buildReportDoc(report(), { author: 'Admin', appVersion: '0.1.13', generatedAt: NOW.toISOString() });
    const table = documentNodes(doc, { defang: false }).find((n): n is TableNode => n.k === 'table')!;
    const row = table.rows.find((r) => r[0] === 'Rules');
    expect(row?.map((cell) => (typeof cell === 'string' ? cell : JSON.stringify(cell)))).toEqual(['Rules', expect.stringContaining(SSH)]);
    const md = reportToMarkdown(doc, { defang: false });
    expect(md).toContain('web_scan');
    expect(md).not.toMatch(/\]\(#\//);
  });

  it('the conversation Markdown', () => {
    const md = conversationToMarkdown(conversation(), { now: NOW });
    expect(md).toContain(SSH);
    expect(md).not.toMatch(/\]\(#\//);
  });
});
