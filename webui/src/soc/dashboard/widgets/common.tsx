/**
 * Shared scaffolding for dashboard widget bodies (Round 5 / G7; Round 14, SPEC §4.4.3).
 *
 * Every widget receives {@link WidgetProps}: its persisted `options` (an operator-authored
 * PLAIN-data bag, #9) and an optional title override. A widget names the data it reads
 * (`useDashboardRequest`), never fetches on its own, never writes, and its layout is
 * advisory (never feeds `decide()`, #3).
 *
 * `WidgetShell` is the one module frame: the Overview's tinted borderless panel
 * (the shared `Panel`) with a title, a caption that starts with the window or "Open
 * now", and a "View ..." exit to the page that lists the population. It owns the
 * universal states so a body only draws its ready state:
 *
 *   - loading: a skeleton in the panel (never a spinner);
 *   - no data: `EmptyState state="no-data"` naming the window ("No cases in the last 24
 *     hours");
 *   - error: `LoadError` with Retry for that widget only; while it is read again the
 *     error stays, its Retry keeps its place (and keyboard focus) and says "Retrying";
 *   - no access: the viewer's role cannot read it;
 *   - row-level scope: "Hidden while row-level scope is on." (D16);
 *   - an honest gap: `EmptyState state="unavailable"` with the reason, never a zero;
 *   - stale: a refresh failed (or has run past one refresh interval without an answer)
 *     while an earlier answer is held, so the body keeps those figures under one line
 *     that says so, with the time they were read and Retry ("Refresh failed. Showing
 *     figures loaded at 14:02."), never passed off as current. The line stays while the
 *     figures are read again, its Retry busy ("Retrying"), until a read succeeds.
 *
 * In VIEW mode a widget is sized to its content (no clipped bodies, F3). In EDIT mode it
 * sits in a fixed grid cell: the panel fills the cell, the title and caption stay put and
 * only the body below them scrolls, so nothing is clipped at the top of a cell.
 * Titles and every label are plain text (#9).
 */
import * as React from 'react';
import { AlertTriangle, ArrowRight, RefreshCw, type LucideIcon } from 'lucide-react';

import { Panel } from '@/design-system/panel';
import { cn } from '@/lib/cn';
import type { NavOpts } from '@/lib/types';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { pageHash, type PageId } from '@/soc/router';
import { safeRouteHref, useRouteLinkClick } from '@/soc/route-link';

import { clockText } from './format';
import { SCOPE_UNCONFIRMED_MESSAGE, ScopeUnconfirmedError, isScopeRefusal } from './requests';

export { SCOPE_UNCONFIRMED_MESSAGE };

/** Declarative per-widget config (title override, series, by, …): PLAIN data (#9). */
export type WidgetOptions = Record<string, unknown>;

/** Props every widget body receives. `options` is the persisted declarative config. */
export interface WidgetProps<O extends WidgetOptions = WidgetOptions> {
  /** The widget instance id. */
  id: string;
  /** Declarative config from the persisted `DashboardWidget.options` (PLAIN data #9). */
  options: O;
  /** Operator title override (PLAIN text #9); the registry title when absent. */
  title?: string;
}

/**
 * Read an optional PLAIN-text title from a widget's options bag, falling back to the
 * registry default. Coerced to a string so a tampered option can never inject a node (#9).
 */
export function resolveTitle(props: Pick<WidgetProps, 'title' | 'options'>, fallback: string): string {
  const fromOptions = props.options?.title;
  const raw = props.title ?? (typeof fromOptions === 'string' ? fromOptions : undefined);
  const s = (raw ?? '').trim();
  return s || fallback;
}

/** A string option, when it is one of `allowed`; else `fallback`. */
export function optionChoice<T extends string>(
  options: WidgetOptions | undefined,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = options?.[key];
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** A whole-number option within [min, max] (a string from the config sheet is accepted); else `fallback`. */
export function optionInt(options: WidgetOptions | undefined, key: string, min: number, max: number, fallback: number): number {
  const raw = options?.[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// The shared number words (pure, so the KPI evaluator can use them without React).
export { countOf, moneyText, percentText, shareOf, shareText, signedDuration } from './format';

// --------------------------------------------------------------------------- //
// Frame mode (view: content-sized; edit: fixed grid cell)
// --------------------------------------------------------------------------- //

export type WidgetFrameMode = 'view' | 'edit';

/** Provided by `WidgetGrid`: whether the widget sits in a content-sized or fixed cell. */
export const WidgetFrameContext = React.createContext<WidgetFrameMode>('view');

// --------------------------------------------------------------------------- //
// The "View ..." exit
// --------------------------------------------------------------------------- //

export interface WidgetExitTarget {
  /** "View cases", "Open Auto-tuning" (sentence case). */
  label: string;
  page: PageId;
  opts?: NavOpts;
}

/**
 * The module's exit to the page that lists its population. It navigates, so it is a
 * link (`<a href>`, SPEC §3.3); a plain click goes through the router so a page's
 * leave guard is asked first.
 */
export function WidgetExit({ target }: { target: WidgetExitTarget }) {
  const href = safeRouteHref(pageHash(target.page, target.opts));
  const onClick = useRouteLinkClick(href);
  if (!href) return null;
  return (
    <a
      href={href}
      onClick={onClick}
      className={cn(
        // `min-h-6`: a 24 px pointer target (SPEC §3.3); inline-flex centres the words.
        'inline-flex min-h-6 shrink-0 items-center gap-1 rounded-sm py-0.5 text-sm font-medium text-primary',
        'hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      data-widget-exit=""
    >
      {target.label}
      <ArrowRight className="size-3.5" aria-hidden />
    </a>
  );
}

// --------------------------------------------------------------------------- //
// States
// --------------------------------------------------------------------------- //

/** The universal states a widget body may be in instead of its ready body. */
export type WidgetState =
  | { kind: 'loading' }
  | { kind: 'empty'; title: string; description?: string }
  /** `retrying`: the failed read is being read again (the error stays, Retry is busy). */
  | { kind: 'error'; error: unknown; onRetry?: () => void; retrying?: boolean }
  | { kind: 'denied' }
  | { kind: 'scoped' }
  /** The viewer's row-level scope could not be read: nothing was fetched; Retry reads it again. */
  | { kind: 'unconfirmed'; onRetry?: () => void }
  | { kind: 'unavailable'; title: string; description?: string };

/** The sentence a case-derived panel shows while row-level data scope is on (D16). */
export const SCOPED_SENTENCE = 'Hidden while row-level scope is on.';

/** Why an unconfirmed panel shows nothing (under {@link SCOPE_UNCONFIRMED_MESSAGE}). */
export const SCOPE_UNCONFIRMED_DETAIL = 'Case figures stay hidden until it is confirmed.';

/**
 * The body of a universal state (skeleton, empty, LoadError with Retry, no access, row-
 * level scope, unconfirmed scope, an honest gap). Exported for the few modules that draw
 * their own panel (Response timing, Human vs AI), so every widget speaks one grammar.
 */
export function WidgetStateView({ state, title, emptyIcon }: { state: WidgetState; title: string; emptyIcon?: LucideIcon }) {
  return <StateBody state={state} title={title} emptyIcon={emptyIcon} />;
}

function StateBody({ state, title, emptyIcon }: { state: WidgetState; title: string; emptyIcon?: LucideIcon }) {
  switch (state.kind) {
    case 'loading':
      return (
        <div className="space-y-2.5" aria-busy="true" data-widget-state="loading">
          <span className="sr-only">Loading {title}</span>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      );
    case 'empty':
      return (
        <EmptyState
          state="no-data"
          icon={emptyIcon}
          title={state.title}
          description={state.description}
          compact
          data-widget-state="empty"
        />
      );
    case 'error':
      // While the failed read is read again the error stays and so does its Retry, so
      // keyboard focus is not dropped; it says "Retrying" and a press does nothing.
      return (
        <div data-widget-state="error" aria-busy={state.retrying || undefined}>
          <LoadError
            title={`${title} could not be loaded.`}
            error={state.error}
            fallback="The server did not answer."
            onRetry={state.onRetry ? (state.retrying ? ignoreRetry : state.onRetry) : undefined}
            retryLabel={state.retrying ? 'Retrying' : undefined}
          />
        </div>
      );
    case 'denied':
      return (
        <EmptyState
          state="unavailable"
          title="No access"
          description="Your role does not have the permission this panel needs."
          compact
          data-widget-state="denied"
        />
      );
    case 'scoped':
      return <EmptyState state="unavailable" title={SCOPED_SENTENCE} compact data-widget-state="scoped" />;
    case 'unconfirmed':
      return (
        <div data-widget-state="unconfirmed">
          <LoadError title={SCOPE_UNCONFIRMED_MESSAGE} error={null} fallback={SCOPE_UNCONFIRMED_DETAIL} onRetry={state.onRetry} />
        </div>
      );
    case 'unavailable':
      return (
        <EmptyState
          state="unavailable"
          title={state.title}
          description={state.description}
          compact
          data-widget-state="unavailable"
        />
      );
    default:
      return null;
  }
}

/**
 * The module caption on its own line under the title (the approved board grammar, C2):
 * the title row then holds only the title and the "View ..." exit, so the exit stays at
 * the top right however narrow the panel is, and the caption wraps under the title
 * instead of pushing the exit onto a line of its own. It sits OUTSIDE any scroller, so
 * the line it pulls up under the title row is never clipped.
 */
export function WidgetCaption({ children }: { children?: React.ReactNode }) {
  if (children == null || children === false || children === '') return null;
  return (
    <p className="-mt-2 mb-3 min-w-0 break-words text-sm text-muted-foreground" data-widget-caption="">
      {children}
    </p>
  );
}

// --------------------------------------------------------------------------- //
// Stale: a held answer whose refresh failed
// --------------------------------------------------------------------------- //

/** Why held figures are not current: their refresh failed, or it has not answered yet. */
export type StaleReason = 'failed' | 'slow';

/** Held figures that are not current: when they were read, why, and how to read them again. */
export interface StaleInfo {
  /** When the figures on screen were read (epoch ms), when known. */
  loadedAt: number | null;
  /**
   * `failed`: a refresh failed (Retry is offered). `slow`: a refresh has run past one
   * refresh interval without an answer (nothing to retry yet; it may still land).
   */
  reason: StaleReason;
  /** A failed read is being read again right now (Retry shows "Retrying"). */
  busy: boolean;
  onRetry?: () => void;
}

/** One answer as the provider holds it, with the time it was read. */
export interface HeldAnswer {
  loading: boolean;
  data: unknown;
  error: unknown;
  loadedAt?: number;
  /** Its read in flight has run past one refresh interval (see the provider). */
  overdue?: boolean;
}

/**
 * Whether an answer is stale: it holds figures from an earlier read while its latest
 * refresh failed (the failure holds while it is read again, until a read succeeds) or
 * while a refresh has run past one refresh interval without an answer. A row-level scope
 * refusal is not staleness: the panel hides itself for it instead.
 */
export function isStale(answer: HeldAnswer): boolean {
  if (answer.data == null || isScopeRefusal(answer.error)) return false;
  return answer.error != null || answer.overdue === true;
}

/**
 * The stale note for the answers a panel reads, or `null` when every one is current. The
 * time is the oldest of the held answers' read times (the panel is as old as its oldest
 * figure). A failure wins over a slow read, and the note is busy while a failed read is
 * being read again.
 */
export function staleOf(answers: HeldAnswer | readonly HeldAnswer[], onRetry?: () => void): StaleInfo | null {
  const list = Array.isArray(answers) ? (answers as readonly HeldAnswer[]) : [answers as HeldAnswer];
  const stale = list.filter(isStale);
  if (stale.length === 0) return null;
  const failed = stale.filter((a) => a.error != null);
  const times = stale.map((a) => a.loadedAt).filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  return {
    loadedAt: times.length ? Math.min(...times) : null,
    reason: failed.length > 0 ? 'failed' : 'slow',
    busy: failed.some((a) => a.loading),
    onRetry,
  };
}

/** The first words of a stale note, by why the figures are held. */
export const STALE_LEAD: Readonly<Record<StaleReason, string>> = {
  failed: 'Refresh failed.',
  slow: 'Refresh is taking longer than usual.',
};

/** "Refresh failed. Showing figures loaded at 14:02." (the time only when it is known). */
export function staleSentence(loadedAt: number | null, lead: string = STALE_LEAD.failed): string {
  const at = loadedAt != null ? clockText(loadedAt) : '';
  return `${lead} Showing figures loaded${at ? ` at ${at}` : ' earlier'}.`;
}

/** A Retry that a press during a read in flight must not repeat. */
function ignoreRetry(): void {}

/**
 * Retry for a held or failed answer. While the read it started is in flight it stays in
 * place (so keyboard focus stays on it), says "Retrying", is `aria-disabled` and
 * `aria-busy`, and a press does nothing. It is never `disabled`: a disabled button drops
 * focus to the page. The glyph never spins: the words say it is busy, and the page's
 * `RefreshButton` is the console's one refresh spinner (SPEC §4.9.2).
 */
export function RetryButton({ busy, onRetry, className }: { busy: boolean; onRetry: () => void; className?: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={cn(busy && 'cursor-progress opacity-60', className)}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={busy ? ignoreRetry : onRetry}
      data-retry-busy={busy ? '' : undefined}
    >
      <RefreshCw aria-hidden />
      {busy ? 'Retrying' : 'Retry'}
    </Button>
  );
}

/**
 * The one line a panel shows over figures it kept: a glyph and words (never colour
 * alone), why they are held, the time they were read, and Retry when a refresh failed.
 * Polite status, so a screen reader hears it once when it appears. It stays while the
 * figures are read again (Retry busy), until a read succeeds.
 */
export function StaleNote({ stale, lead, className }: { stale: StaleInfo; lead?: string; className?: string }) {
  return (
    <div
      className={cn('mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}
      role="status"
      data-widget-stale={stale.reason}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <AlertTriangle className="size-3.5 shrink-0 text-warning-text" aria-hidden />
        <span className="min-w-0 break-words">{staleSentence(stale.loadedAt, lead ?? STALE_LEAD[stale.reason])}</span>
      </span>
      {stale.onRetry && stale.reason === 'failed' ? (
        <RetryButton busy={stale.busy} onRetry={stale.onRetry} className="h-7 px-2.5" />
      ) : null}
    </div>
  );
}

export interface WidgetShellProps {
  title: string;
  /** A muted caption on its own line under the title: the window or "Open now" first. */
  caption?: React.ReactNode;
  /** The "View ..." exit on the right of the title row. */
  exit?: WidgetExitTarget | null;
  /** A quiet line under the body (a population note, a scale note). */
  footer?: React.ReactNode;
  /** The state to show instead of the body (see {@link WidgetState}). */
  state?: WidgetState | null;
  /** Figures kept through a failed refresh: the body stays, with one line that says so. */
  stale?: StaleInfo | null;
  /** Legacy: true shows the loading state. */
  loading?: boolean;
  /** Legacy: a string shows a no-data state; a node replaces the body. */
  emptyMessage?: React.ReactNode;
  /** Icon for the no-data state. */
  emptyIcon?: LucideIcon;
  /** @deprecated Module titles carry no icon (Round 14); accepted, not drawn. */
  icon?: LucideIcon;
  /** @deprecated Unused since the icon chip is gone. */
  accentClass?: string;
  /** A control on the right of the title row (instead of, or before, the exit). */
  action?: React.ReactNode;
  /** In a fixed (edit-mode) cell, let a tall body scroll inside the panel (default on). */
  scrollBody?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * The standard widget frame: the module `Panel` with its title row, the caption, then the
 * body. See the module comment for the states and the two modes.
 */
export function WidgetShell({
  title,
  caption,
  exit,
  footer,
  state,
  stale,
  loading,
  emptyMessage,
  emptyIcon,
  action,
  scrollBody,
  className,
  children,
}: WidgetShellProps) {
  const mode = React.useContext(WidgetFrameContext);
  let resolved: WidgetState | null = state ?? null;
  if (!resolved && loading) resolved = { kind: 'loading' };
  let body: React.ReactNode;
  if (resolved) {
    body = <StateBody state={resolved} title={title} emptyIcon={emptyIcon} />;
  } else if (emptyMessage != null && emptyMessage !== false) {
    body =
      typeof emptyMessage === 'string' ? (
        <StateBody state={{ kind: 'empty', title: emptyMessage }} title={title} emptyIcon={emptyIcon} />
      ) : (
        emptyMessage
      );
  } else {
    body = children;
  }
  const showFooter = footer != null && footer !== false && !resolved && (emptyMessage == null || emptyMessage === false);
  // The held figures are on screen only when the body is (not under a state of its own).
  const showStale = stale != null && !resolved;
  const titleAction =
    action || exit ? (
      <>
        {action}
        {exit ? <WidgetExit target={exit} /> : null}
      </>
    ) : undefined;
  const edit = mode === 'edit';
  const scroll = edit && (scrollBody ?? true);
  return (
    <Panel
      title={title}
      actions={titleAction}
      // VIEW: the panel is as tall as its content (F3, no clipped bodies). EDIT: it fills
      // its fixed cell and clips to it; the title row and caption stay in place and only
      // the body region below them scrolls (a scroller around the caption would clip the
      // line it pulls up under the title).
      className={cn('flex h-full flex-col', edit && 'min-h-0 overflow-hidden', className)}
      data-widget-panel=""
    >
      <WidgetCaption>{caption}</WidgetCaption>
      <div className={cn('min-w-0 flex-1', scroll && 'min-h-0 overflow-auto')} data-widget-scroll={scroll ? '' : undefined}>
        {showStale ? <StaleNote stale={stale} /> : null}
        {/* A named size container: a panel table switches to its two-line list by the
            width of this body, not the viewport (`panel-table.tsx`). */}
        <div className="@container/widget min-w-0" data-widget-body="">
          {body}
        </div>
        {showFooter ? (
          <p className="mt-3 text-xs text-muted-foreground" data-widget-footer="">
            {footer}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

/**
 * The state for a body that reads one request: loading while its first answer is
 * pending, the error with Retry when it failed with nothing held (still the error, with a
 * busy Retry, while it is read again), else none (ready). A held answer whose refresh
 * failed is ready here (its body still draws); {@link staleOf} says that it is stale.
 *
 * Two failures are not load errors. A read the server refused because row-level scope
 * applies (`409 breakdown_scope_unsupported`) is the scope sentence, with no Retry (it
 * would be refused again). A read not made because the viewer's scope could not be read
 * offers Retry, which reads the scope again.
 */
export function requestState(
  answer: { loading: boolean; data: unknown; error: unknown },
  onRetry?: () => void,
): WidgetState | null {
  if (answer.data == null && answer.error != null) {
    if (isScopeRefusal(answer.error)) return { kind: 'scoped' };
    if (answer.error instanceof ScopeUnconfirmedError) return { kind: 'unconfirmed', onRetry };
    return { kind: 'error', error: answer.error, onRetry, retrying: answer.loading };
  }
  if (answer.data == null) return { kind: 'loading' };
  return null;
}
