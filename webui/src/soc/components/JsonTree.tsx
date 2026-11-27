/**
 * A collapsible JSON tree, and a viewer around it with search, Copy JSON and Download
 * (Round 14 SPEC §4.5.2; moved here from `components/audit/` by Round 16 SPEC §4.5 WP14,
 * which re-exports it there, so the audit inspector and the case records share it).
 *
 * Every key and value is a text node (never HTML, #9): a record can carry values a log
 * source, a model or a caller chose. Branches are buttons (`aria-expanded`), so the tree
 * is keyboard expandable with Tab, Enter and Space; the first two levels start open. Very
 * deep or very wide values are cut with a visible note rather than freezing the page;
 * Copy JSON always takes the whole value.
 *
 * {@link JsonViewer} adds a search over keys and values (the matching fields as a flat
 * list of paths), Copy JSON (the exact text it was given, else the value as indented
 * JSON) and Download (that text as a file).
 */
import * as React from 'react';
import { Check, ChevronRight, Copy, Download } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { downloadBlob } from '@/lib/download-blob';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

/** Branches deeper than this are shown closed with their size only. */
const MAX_DEPTH = 12;
/** Entries listed per branch before "and N more". */
const MAX_ENTRIES = 200;
/** Matching fields listed by a search before "and N more". */
export const MAX_MATCHES = 300;

function describe(value: unknown): string {
  if (Array.isArray(value)) return `${value.length.toLocaleString()} ${value.length === 1 ? 'item' : 'items'}`;
  const n = Object.keys(value as Record<string, unknown>).length;
  return `${n.toLocaleString()} ${n === 1 ? 'field' : 'fields'}`;
}

/** A leaf value as the tree prints it: strings quoted, everything else as written. */
export function leafText(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'undefined' : String(value);
}

function Leaf({ name, value }: { name: string | null; value: unknown }) {
  return (
    <div className="flex min-w-0 gap-1.5 py-0.5 pl-5">
      {name !== null ? <span className="shrink-0 text-muted-foreground">{name}:</span> : null}
      <span className={cn('min-w-0 [overflow-wrap:anywhere]', typeof value === 'string' ? 'text-foreground' : 'text-primary')}>
        {leafText(value)}
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

/** One field a search found: its dotted path and its value as the tree prints it. */
export interface JsonMatch {
  path: string;
  text: string;
}

/** A path segment: a plain key as `.key`, an index as `[3]`, anything else quoted. */
function pathSegment(parent: string, key: string, isIndex: boolean): string {
  if (isIndex) return `${parent}[${key}]`;
  if (/^[A-Za-z_][\w-]*$/.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Every field whose key or printed value contains `query` (case-insensitive), in
 * document order, at most `limit`, plus the total found. A branch whose key matches is
 * listed as a field too. Pure; bounded by depth like the tree.
 */
export function searchJson(value: unknown, query: string, limit = MAX_MATCHES): { matches: JsonMatch[]; total: number } {
  const needle = query.trim().toLowerCase();
  const matches: JsonMatch[] = [];
  let total = 0;
  if (!needle) return { matches, total };
  const visit = (node: unknown, path: string, key: string | null, depth: number) => {
    const keyHit = key !== null && key.toLowerCase().includes(needle);
    if (node !== null && typeof node === 'object') {
      if (keyHit) {
        total += 1;
        if (matches.length < limit) matches.push({ path, text: Array.isArray(node) ? `[ ${describe(node)} ]` : `{ ${describe(node)} }` });
      }
      if (depth >= MAX_DEPTH) return;
      if (Array.isArray(node)) node.forEach((item, i) => visit(item, pathSegment(path, String(i), true), null, depth + 1));
      else for (const [k, v] of Object.entries(node)) visit(v, pathSegment(path, k, false), k, depth + 1);
      return;
    }
    const text = leafText(node);
    if (keyHit || text.toLowerCase().includes(needle)) {
      total += 1;
      if (matches.length < limit) matches.push({ path: path || '(value)', text });
    }
  };
  visit(value, '', null, 0);
  return { matches, total };
}

export interface JsonViewerProps {
  value: unknown;
  /** The accessible name of the tree ("Case record"). */
  label: string;
  /** The exact text Copy JSON and Download take; defaults to the value as indented JSON. */
  text?: string;
  /** The Download file name; no Download button without one. */
  filename?: string;
  /** Offer the search box (default true). */
  searchable?: boolean;
  /** Called after a copy with whether it worked, for a live announcement. */
  onCopied?: (ok: boolean) => void;
  className?: string;
  treeClassName?: string;
}

/** The tree with a search over keys and values, Copy JSON and Download. */
export function JsonViewer({
  value,
  label,
  text,
  filename,
  searchable = true,
  onCopied,
  className,
  treeClassName,
}: JsonViewerProps) {
  const [query, setQuery] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const searchId = React.useId();
  const exact = React.useMemo(() => {
    if (typeof text === 'string') return text;
    try {
      return JSON.stringify(value, null, 2) ?? '';
    } catch {
      return String(value);
    }
  }, [text, value]);
  const found = React.useMemo(() => searchJson(value, query), [value, query]);
  const searching = query.trim().length > 0;

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void copyText(exact).then((ok) => {
      setCopied(ok);
      onCopied?.(ok);
    });
  };
  const download = () => {
    if (!filename) return;
    downloadBlob(filename, new Blob([exact], { type: 'application/json' }));
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {searchable ? (
          <>
            <label htmlFor={searchId} className="sr-only">
              Search fields
            </label>
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search fields and values"
              className="h-8 min-w-0 flex-1 basis-48 text-sm"
            />
          </>
        ) : null}
        <div className={cn('flex items-center gap-2', !searchable && 'ml-auto')}>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={copy}>
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          {filename ? (
            <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={download}>
              <Download className="size-3.5" aria-hidden />
              Download
            </Button>
          ) : null}
        </div>
      </div>
      {searching ? (
        <div className="min-w-0" data-testid="json-search-results">
          <p className="mb-1 text-xs text-muted-foreground" aria-live="polite">
            {found.total === 0
              ? 'No field matches.'
              : `${found.total.toLocaleString()} matching field${found.total === 1 ? '' : 's'}${
                  found.total > found.matches.length ? `, the first ${found.matches.length.toLocaleString()} shown` : ''
                }.`}
          </p>
          {found.matches.length ? (
            <ul className="min-w-0 space-y-0.5 rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs">
              {found.matches.map((match, index) => (
                <li key={`${match.path}-${index}`} className="flex min-w-0 gap-1.5">
                  <span className="shrink-0 text-muted-foreground [overflow-wrap:anywhere]">{match.path}:</span>
                  <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{match.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <JsonTree value={value} label={label} className={treeClassName} />
      )}
    </div>
  );
}
