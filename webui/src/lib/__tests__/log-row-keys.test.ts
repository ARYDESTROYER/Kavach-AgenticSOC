/**
 * Log row keys (`lib/log-row-keys`): unique per row, built from fields that do not
 * move with list position, so an expanded row stays expanded across a refresh.
 */
import { describe, expect, it } from 'vitest';

import { logRowKeys, pruneExpandedKeys } from '../log-row-keys';

const row = (id: string, ts: string, source_id?: string) => ({ id, ts, source_id });

describe('logRowKeys', () => {
  it('keeps two sources apart and two events with one id apart by time', () => {
    const keys = logRowKeys([
      row('evt-2', '2026-07-01T10:04:00Z', 'src-elastic'),
      row('evt-2', '2026-07-01T10:03:00Z', 'src-elastic'),
      row('evt-2', '2026-07-01T10:04:00Z', 'src-wazuh'),
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  it('numbers only exact repeats, from the end of the list', () => {
    const same = row('evt-x', '2026-07-01T10:00:00Z', 'demo-qradar');
    const keys = logRowKeys([same, same, same]);
    expect(new Set(keys).size).toBe(3);
    // The last row keeps the plain key; a copy added at the top takes a new number
    // instead of renumbering the rows below it.
    expect(logRowKeys([same, same, same, same]).slice(1)).toEqual(keys);
  });

  it('gives every row the same key after a newer row arrives at the top', () => {
    const rows = [row('evt-x', '2026-07-01T10:02:00Z'), row('evt-x', '2026-07-01T10:01:00Z')];
    const before = logRowKeys(rows);
    const after = logRowKeys([row('evt-x', '2026-07-01T10:03:00Z'), ...rows]);
    expect(after.slice(1)).toEqual(before);
    expect(after[0]).not.toBe(before[0]);
  });

  it('cannot be confused by separators inside an id or a source', () => {
    expect(logRowKeys([row('b::c', 't', 'a')])[0]).not.toBe(logRowKeys([row('c', 't', 'a::b')])[0]);
  });

  it('pruneExpandedKeys keeps only keys still on screen', () => {
    const rows = [row('a', '1'), row('b', '2')];
    const [ka, kb] = logRowKeys(rows);
    expect(pruneExpandedKeys(new Set([ka, kb, 'gone']), [rows[1]])).toEqual(new Set([kb]));
  });
});
