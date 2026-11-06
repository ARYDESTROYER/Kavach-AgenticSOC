/**
 * A collapsible JSON tree for the audit inspector's `tool_input` (Round 14 SPEC §4.5.2).
 *
 * Every key and value is a text node (never HTML, #9): `tool_input` can carry values a
 * log source or a caller chose. Branches are buttons (`aria-expanded`), so the tree is
 * keyboard expandable with Tab, Enter and Space; the first two levels start open. Very
 * deep or very wide values are cut with a visible note rather than freezing the page;
 * Copy JSON (beside the tree) always takes the whole value.
 */
import * as React from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/cn';

/** Branches deeper than this are shown closed with their size only. */
const MAX_DEPTH = 12;
/** Entries listed per branch before "and N more". */
const MAX_ENTRIES = 200;

function describe(value: unknown): string {
  if (Array.isArray(value)) return `${value.length.toLocaleString()} ${value.length === 1 ? 'item' : 'items'}`;
  const n = Object.keys(value as Record<string, unknown>).length;
  return `${n.toLocaleString()} ${n === 1 ? 'field' : 'fields'}`;
}

function Leaf({ name, value }: { name: string | null; value: unknown }) {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'undefined' : String(value);
  return (
    <div className="flex min-w-0 gap-1.5 py-0.5 pl-5">
      {name !== null ? <span className="shrink-0 text-muted-foreground">{name}:</span> : null}
      <span className={cn('min-w-0 [overflow-wrap:anywhere]', typeof value === 'string' ? 'text-foreground' : 'text-primary')}>
        {text}
      </span>
    </div>
  );
}

function Branch({ name, value, depth }: { name: string | null; value: object; depth: number }) {
  const [open, setOpen] = React.useState(depth < 2);
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, i) => [String(i), item])
    : Object.entries(value);
  const shown = entries.slice(0, MAX_ENTRIES);
  const canOpen = depth < MAX_DEPTH && entries.length > 0;
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-6 items-center gap-1 rounded-sm py-0.5 pr-1 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-standard motion-reduce:transition-none',
            open && canOpen && 'rotate-90',
            !canOpen && 'opacity-0',
          )}
          aria-hidden
        />
        {name !== null ? <span className="text-muted-foreground">{name}:</span> : null}
        <span className="text-muted-foreground">
          {Array.isArray(value) ? '[ ' : '{ '}
          {describe(value)}
          {Array.isArray(value) ? ' ]' : ' }'}
        </span>
      </button>
      {open && canOpen ? (
        <div className="ml-1.5 border-l border-border/70 pl-2">
          {shown.map(([key, item]) => (
            <JsonNode key={key} name={Array.isArray(value) ? null : key} value={item} depth={depth + 1} />
          ))}
          {entries.length > shown.length ? (
            <p className="py-0.5 pl-5 text-muted-foreground">
              and {(entries.length - shown.length).toLocaleString()} more (Copy JSON takes them all)
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function JsonNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  if (value !== null && typeof value === 'object') return <Branch name={name} value={value} depth={depth} />;
  return <Leaf name={name} value={value} />;
}

export interface JsonTreeProps {
  value: unknown;
  /** The accessible name of the tree group ("Tool input"). */
  label: string;
  className?: string;
}

/** The tree; a scalar renders as one line. */
export function JsonTree({ value, label, className }: JsonTreeProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('min-w-0 rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs', className)}
    >
      <JsonNode name={null} value={value} depth={0} />
    </div>
  );
}
