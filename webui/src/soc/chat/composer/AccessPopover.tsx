/**
 * AccessPopover — "What can the assistant access?" (SPEC §5.6, §10.4, §10.5).
 *
 * Lists the caller's tool catalogue from `/chat/context`, grouped by scope: each
 * capability in the present tense ("Search logs", never the run log's "Searched
 * logs"), its data source, the permission it needs, and either ✓ or "Needs <perm>"
 * (any one of several for a kind-gated tool). The catalogue is the server's
 * per-principal view, so this is what the assistant can actually read for THIS user;
 * it never claims more. While the context loads it says so; when it cannot be read
 * it says that once, with Retry, instead of "Checking…" forever. Every string came
 * through `normaliseChatContext` (display-sanitised) and renders as text (#9).
 *
 * The trigger is the caller's element (`asChild`), so the composer's Read-only chip
 * and the empty state's link open the same surface.
 */
import * as React from 'react';
import { Check, Lock, RotateCcw } from 'lucide-react';
import type { ChatContextInfo, ChatScope, ChatToolInfo } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { CHAT_SCOPES } from '../stream-events';
import { SCOPE_LABELS } from './format';
import { capabilityLabel } from './access-copy';
import { missingGrant } from './commands';

/** The honest line shown when `/chat/context` could not be read. */
export const ACCESS_UNAVAILABLE = "Couldn't load what the assistant can access.";

export interface AccessStateProps {
  context: ChatContextInfo | null;
  /** `/chat/context` failed and nothing is cached (`useChatContext().error`). */
  error?: string | null;
  /** Retry the read (`useChatContext().refresh`). */
  onRetry?: () => void;
}

/** One quiet line + Retry for a context that could not be read (shared with the empty state). */
export function ContextUnavailable({ onRetry, className }: { onRetry?: () => void; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground', className)}>
      <span>{ACCESS_UNAVAILABLE}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:underline',
            focusRing,
          )}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      ) : null}
    </p>
  );
}

export interface AccessPopoverProps extends AccessStateProps {
  /** The trigger element (rendered with `asChild`). */
  children: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

/** Per-kind grants this caller lacks on a partly available tool. */
function lockedKinds(tool: ChatToolInfo): string[] {
  const requires = tool.kind_requires ?? {};
  const allowed = new Set(tool.kinds_allowed ?? []);
  const out: string[] = [];
  for (const [kind, grant] of Object.entries(requires)) {
    if (!allowed.has(kind) && !out.includes(grant)) out.push(grant);
  }
  return out;
}

function ToolRow({ tool }: { tool: ChatToolInfo }) {
  const missing = missingGrant(tool);
  const partly = tool.allowed ? lockedKinds(tool) : [];
  const needs = tool.requires.length ? tool.requires.join(', ') : 'No permission needed';
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        {tool.allowed ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className={tool.allowed ? 'text-foreground' : 'text-muted-foreground'}>{capabilityLabel(tool)}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {tool.allowed ? (
              <>
                <span className="sr-only">Allowed. </span>
                {needs}
              </>
            ) : (
              <span className="font-medium text-foreground">Needs {missing ?? 'access'}</span>
            )}
          </span>
        </div>
        {tool.data_source ? <p className="truncate text-2xs text-muted-foreground">{tool.data_source}</p> : null}
        {partly.length ? (
          <p className="text-2xs text-muted-foreground">Some details need {partly.join(' or ')}</p>
        ) : null}
      </div>
    </li>
  );
}

/** The popover body, exported for tests and for hosts that render it inline. */
export function AccessList({ context, error = null, onRetry }: AccessStateProps) {
  // Heading ids must be unique per mounted list: the composer chip and the empty
  // state's link can both have one open in the same document.
  const baseId = React.useId();
  if (!context) {
    if (error) return <ContextUnavailable onRetry={onRetry} />;
    return <p className="text-xs text-muted-foreground">Checking what you can access…</p>;
  }
  const groups = CHAT_SCOPES.map((scope) => ({
    scope,
    tools: context.tools.filter((tool) => tool.scope === scope),
  })).filter((group) => group.tools.length > 0);
  if (!groups.length) {
    return <p className="text-xs text-muted-foreground">The assistant has no data tools for your role.</p>;
  }
  const allowed = context.tools.filter((tool) => tool.allowed).length;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {allowed} of {context.tools.length} lookups are available to you.
      </p>
      {groups.map((group) => (
        <section key={group.scope} aria-labelledby={`${baseId}-${group.scope}`}>
          <h3
            id={`${baseId}-${group.scope}`}
            className="text-2xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {SCOPE_LABELS[group.scope as ChatScope]}
          </h3>
          <ul className="divide-y divide-border text-xs">
            {group.tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function AccessPopover({
  context,
  error = null,
  onRetry,
  children,
  open,
  onOpenChange,
  side = 'top',
  align = 'start',
}: AccessPopoverProps) {
  const titleId = React.useId();
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        aria-labelledby={titleId}
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
        collisionPadding={8}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-foreground">
            What the assistant can access
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Read-only lookups, checked against your permissions. It cannot change anything.
          </p>
        </div>
        <div className="max-h-[min(24rem,60dvh)] overflow-y-auto px-4 py-3">
          <AccessList context={context} error={error} onRetry={onRetry} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
