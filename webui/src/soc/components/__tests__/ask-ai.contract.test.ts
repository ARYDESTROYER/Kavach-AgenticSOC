/**
 * The Ask AI grammar contract (Round 12 WP-ASK): the console shows a chip exactly for the
 * values the server will word a question about. Both sides read the same table
 * (`ask-ai.contract.json`; the server's half is `backend/tests/test_chat_entity_ask.py`),
 * so a value the console accepts is never a 422 and a value the server refuses never
 * gets a chip.
 */
import { describe, expect, it } from 'vitest';

import contract from '@/soc/components/ask-ai.contract.json';

import { ASK_ENTITY_KINDS, askEntityValue } from '../ask-ai';

describe('Ask AI grammar contract', () => {
  it('names the same kinds, in the same order, as the server', () => {
    expect([...ASK_ENTITY_KINDS]).toEqual(contract.kinds);
  });

  it('covers every kind with accepted and refused values', () => {
    for (const kind of contract.kinds) {
      const rows = contract.values.filter((row) => row.kind === kind);
      expect(rows.some((row) => row.ok), kind).toBe(true);
      expect(rows.some((row) => !row.ok), kind).toBe(true);
    }
  });

  it.each(contract.values.map((row) => [`${row.kind}: ${JSON.stringify(row.value).slice(0, 40)}`, row] as const))(
    '%s',
    (_name, row) => {
      const value = askEntityValue(row.kind, row.value);
      expect(value !== null, JSON.stringify(row)).toBe(row.ok);
      // Trimmed, never otherwise altered.
      if (row.ok) expect(value).toBe(row.value.trim());
    },
  );
});
