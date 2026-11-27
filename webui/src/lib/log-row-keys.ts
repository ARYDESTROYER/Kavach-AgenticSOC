/**
 * Stable, unique keys for a list of log rows: the React keys and the expanded-row set
 * of the Logs page (`UnifiedLogsSheet`) and a source's Browse logs sheet
 * (`SourceLogsSheet`).
 *
 * An event `id` is not unique on its own. Two connectors can emit the same id, and
 * one source can return the same id for different events (Demo Mode's QRadar feed
 * derives every id from one LEEF event id; an upstream re-delivery repeats one). So a
 * key is built from fields that do not move when the list changes: the source, the
 * id and the event time. Only rows that repeat all three get an occurrence number,
 * counted from the end of the list, so a newer event arriving at the top never
 * renumbers the rows below it: a row the analyst expanded stays the row that is
 * expanded across a refresh or a live-tail update.
 */
export interface LogRowIdentity {
  id: string;
  ts?: string | null;
  source_id?: string | null;
}

export function logRowKeys(rows: readonly LogRowIdentity[]): string[] {
  const bases = rows.map((row) => JSON.stringify([row.source_id ?? '', row.id, row.ts ?? '']));
  const seen = new Map<string, number>();
  const keys = new Array<string>(rows.length);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const base = bases[i];
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys[i] = n === 1 ? base : `${base}#${n}`;
  }
  return keys;
}

/** `expanded` without the keys that are no longer among `rows` (after a reload). */
export function pruneExpandedKeys(expanded: ReadonlySet<string>, rows: readonly LogRowIdentity[]): Set<string> {
  const present = new Set(logRowKeys(rows));
  const next = new Set<string>();
  for (const key of expanded) if (present.has(key)) next.add(key);
  return next;
}
