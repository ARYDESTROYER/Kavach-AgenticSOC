/**
 * "Open in Logs" (SPEC §10.3, §10.7; WP-INT item 5): a query-backed block carries the
 * server's EXACT console view (`open_in`: the same free text, window and source the tool
 * ran with), validated by the router's own deep-link grammar. The card offers "Open in
 * Logs" only then; a block with any other filter keeps "Copy query" and nothing else,
 * and a model-written block can never carry a navigation target.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/soc/components/announcer', () => ({ useAnnouncer: () => vi.fn() }));

import AnswerBlocks from '../AnswerBlocks';
import { openTargetFor } from '../BlockCard';
import { galleryBlock } from '../__fixtures__/gallery';
import { parseBlock, parseInternalRef } from '../schema';
import type { AnswerBlock } from '../schema';

const LOGS_VIEW = {
  page: 'logs',
  opts: { logQuery: 'failed password', from: 'now-24h', to: 'now', sourceId: 'wazuh-prod' },
} as const;

const queryBlock = (extra: Record<string, unknown> = {}): AnswerBlock =>
  parseBlock({
    id: 'q1',
    type: 'query',
    provenance: 'source',
    artifact_kind: 'query',
    title: 'Query',
    language: 'kql',
    query: 'failed password',
    source_name: 'Wazuh',
    ...extra,
  });

describe('open_in parsing', () => {
  it('keeps a valid logs view on a code/source block', () => {
    const block = queryBlock({ open_in: LOGS_VIEW });
    expect(block.open_in).toEqual(LOGS_VIEW);
    expect(openTargetFor(block)).toEqual(LOGS_VIEW);
  });

  it('drops an invalid view without failing the block', () => {
    for (const opts of [
      { from: 'yesterday' },
      { sourceId: 'a b' },
      { logQuery: 'line\nbreak' },
      { logQuery: 'x', bogus: 1 },
    ]) {
      const block = queryBlock({ open_in: { page: 'logs', opts } });
      expect(block.type).toBe('query');
      expect(block.open_in).toBeUndefined();
      expect(openTargetFor(block)).toBeNull();
    }
    expect(queryBlock({ open_in: { page: 'not_a_page', opts: {} } }).open_in).toBeUndefined();
  });

  it('never keeps a navigation target on a model-written (ai) block', () => {
    const callout = parseBlock({ id: 'c1', type: 'callout', tone: 'info', text: 'See logs', open_in: LOGS_VIEW });
    expect(callout.provenance).toBe('ai');
    expect(callout.open_in).toBeUndefined();
    expect(openTargetFor(callout)).toBeNull();
  });

  it('validates the logs keys exactly like the router deep links', () => {
    expect(parseInternalRef({ page: 'logs', opts: { from: 'now-7d', to: 'now' } })).toEqual({
      page: 'logs',
      opts: { from: 'now-7d', to: 'now' },
    });
    expect(parseInternalRef({ page: 'logs', opts: { from: 'now-7 d' } })).toBeNull();
    expect(parseInternalRef({ page: 'logs', opts: { from_: 'now' } })).toBeNull();
  });
});

describe('Open in Logs on the card', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>, index = 0) {
    await user.click(screen.getAllByTestId('block-menu-trigger')[index]);
    return screen.findByRole('menu');
  }

  it('navigates to the exact logs view, beside Copy query', async () => {
    const user = userEvent.setup();
    const nav = vi.fn();
    render(<AnswerBlocks blocks={[queryBlock({ open_in: LOGS_VIEW })]} messageId="m1" onNavigate={nav} />);
    const menu = await openMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Copy query' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Open in Logs' }));
    expect(nav).toHaveBeenCalledWith(LOGS_VIEW);
  });

  it('offers no Open in Logs when the block carries no exact filter', async () => {
    const user = userEvent.setup();
    render(<AnswerBlocks blocks={[queryBlock(), galleryBlock('top-hosts')]} messageId="m1" />);
    expect(within(await openMenu(user, 0)).queryByRole('menuitem', { name: /Open in/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect(within(await openMenu(user, 1)).queryByRole('menuitem', { name: /Open in/ })).toBeNull();
  });
});
