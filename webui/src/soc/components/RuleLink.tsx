/**
 * RuleLink: the ONE entry point to a detection rule's picture (Round 14, SPEC §4.6.5,
 * operator choice C4 option A). Every rule name the Console shows outside a chat answer
 * (the Case Manager facts rail, the Logs row detail, Auto-tuning, health diagnostics, the
 * Cyber Defence Center's top signatures, the dashboard rule widgets, the severity
 * breakdown) renders through it, so clicking a rule always opens the same rule sheet.
 *
 * It is a `button` styled as inline mono text (a quiet dotted underline at rest, solid on
 * hover and focus), named "Open rule <value>", that opens the lazy `RuleSheet` (a modal
 * side sheet). The sheet is loaded on the first click, so this module stays small: it
 * imports React, the class helper, the module store and the sheet primitives its
 * fail-soft stand-in uses (already in the entry). A module store keeps one open sheet for the whole
 * Console; the link that opened it stays marked (`aria-current="true"`) while it is open,
 * and focus goes back to it when the sheet closes.
 *
 * Hosts that cannot place a button (a chart bar) use {@link useRuleSheet}: it returns an
 * `open()` and the `sheet` node to render once.
 *
 * A link renders its own sheet unless a {@link RuleSheetHost} (or {@link RuleSheetScope})
 * above it provides one. A surface that refreshes on its own (the Logs live tail, the LIVE
 * Cyber Defence Center, Auto-tuning, health diagnostics) wraps its links in one host, so a
 * refresh that re-renders or drops the row that opened the sheet never closes the sheet
 * the person is reading: it closes when they close it, or when the surface itself goes.
 *
 * The sheet's chunk fails soft: when it cannot be fetched (a stale hashed file after a
 * redeploy or a supervised update, a proxy, going offline), a small sheet says so and
 * offers a reload, so a click on a rule never replaces the page the person is working on
 * (an unsaved note, a filtered list) with an error.
 *
 * SECURITY (#9): the rule value is untrusted source data. It is a plain text node and an
 * attribute value, never markup; a value the server's rule grammar refuses (a control
 * or separator character, more than 256 characters) renders as plain text and opens
 * nothing.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';

import type { RuleSheetProps } from './RuleSheet';
import {
  closeRuleSheet,
  getRuleSheetRequest,
  isRuleValue,
  keepKeysInSheet,
  openRuleSheet,
  subscribeRuleSheet,
  takeRuleSheetReturnFocus,
  type RuleSheetRequest,
  type RuleSheetTarget,
  type RuleSheetWindow,
} from './rule-sheet-store';

export type { RuleSheetTarget, RuleSheetWindow } from './rule-sheet-store';
export { isRuleValue } from './rule-sheet-store';

/**
 * Stands in for the sheet when its chunk cannot be fetched: the rule as the title, one
 * line that says the view could not be loaded and a "Reload page" button. React keeps a
 * failed lazy import for the life of the page, so only a reload can fetch it again.
 */
export function RuleSheetUnavailable({ id, request, open, onOpenChange, returnFocusTo }: RuleSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id={id}
        side="right"
        size="xl"
        className="max-w-[46rem] gap-0 p-0"
        data-testid="rule-sheet-unavailable"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.() ?? document.getElementById('socMain');
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        onKeyDown={keepKeysInSheet}
      >
        <div className="space-y-4 p-5 sm:p-6">
          <header className="min-w-0 space-y-1 pr-10">
            <SheetDescription className="text-xs font-medium text-muted-foreground">
              {request.origin ? `From ${request.origin}` : 'Detection rule'}
            </SheetDescription>
            <SheetTitle className="break-words font-mono text-lg [overflow-wrap:anywhere]">{request.rule}</SheetTitle>
          </header>
          <p className="text-sm text-muted-foreground">The rule view could not be loaded. Reload the page to try again.</p>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

const RuleSheet = React.lazy(() => import('./RuleSheet').catch(() => ({ default: RuleSheetUnavailable })));

/** The DOM id of a host's sheet (`aria-controls`), safe for any `useId` output. */
function sheetDomId(hostId: string): string {
  return `rule-sheet-${hostId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export interface UseRuleSheet {
  /**
   * Open the sheet for `target` (ignored when the value cannot be a rule). `linkId` names
   * the link that opened it, so a host shared by many links marks only that one.
   */
  open: (target: RuleSheetTarget, opener?: HTMLElement | null, linkId?: string) => boolean;
  /** Whether THIS host's sheet is the open one (mark the opened row with it). */
  isOpen: boolean;
  /** The rule this host has open, or null. */
  openRule: string | null;
  /** The link that opened this host's sheet, when a link did. */
  openLinkId: string | null;
  /** This host's id; its links carry it, so focus can find the same rule's link again. */
  hostId: string;
  /** The DOM id of the sheet while it is open (for `aria-controls`). */
  sheetId: string;
  /** Render this once, anywhere inside the host. */
  sheet: React.ReactNode;
}

/**
 * One host of the rule sheet. Opening replaces any sheet open elsewhere; the sheet closes
 * when its host unmounts (the surface that opened it is gone).
 */
export function useRuleSheet(): UseRuleSheet {
  const hostId = React.useId();
  const request = React.useSyncExternalStore(subscribeRuleSheet, getRuleSheetRequest, getRuleSheetRequest);
  const mine = request && request.hostId === hostId ? request : null;
  // The last request this host rendered stays mounted (closed) so the sheet can play its
  // exit and hand focus back; it is replaced by the next one this host opens. A ref, not
  // state: a state update during render beside `useSyncExternalStore` stops React from
  // seeing the store's later changes (the close).
  const lastRef = React.useRef<RuleSheetRequest | null>(null);
  if (mine) lastRef.current = mine;
  const last = lastRef.current;

  React.useEffect(() => () => closeRuleSheet(hostId), [hostId]);

  const open = React.useCallback(
    (target: RuleSheetTarget, opener?: HTMLElement | null, linkId?: string) =>
      openRuleSheet(target, hostId, opener, linkId),
    [hostId],
  );
  const onOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) closeRuleSheet(hostId);
    },
    [hostId],
  );
  const takeFocus = React.useCallback(() => takeRuleSheetReturnFocus(hostId), [hostId]);
  const sheetId = sheetDomId(hostId);
  const shown = mine !== null && last !== null && mine.seq === last.seq;

  const sheet = React.useMemo(
    () =>
      last ? (
        <React.Suspense fallback={null}>
          <RuleSheet
            key={last.seq}
            id={sheetId}
            request={last}
            open={shown}
            onOpenChange={onOpenChange}
            returnFocusTo={takeFocus}
          />
        </React.Suspense>
      ) : null,
    [last, shown, sheetId, onOpenChange, takeFocus],
  );

  return React.useMemo(
    () => ({
      open,
      isOpen: mine !== null,
      openRule: mine?.rule ?? null,
      openLinkId: mine?.linkId ?? null,
      hostId,
      sheetId,
      sheet,
    }),
    [open, mine, hostId, sheetId, sheet],
  );
}

const RuleSheetHostContext = React.createContext<UseRuleSheet | null>(null);

/**
 * Gives the `RuleLink`s below it one shared sheet, rendered here: a surface that already
 * holds a `useRuleSheet` (to pause a live tail while its sheet is open, say) passes it in.
 */
export function RuleSheetScope({ host, children }: { host: UseRuleSheet; children?: React.ReactNode }) {
  return (
    <RuleSheetHostContext.Provider value={host}>
      {children}
      {host.sheet}
    </RuleSheetHostContext.Provider>
  );
}

/**
 * One rule sheet for every `RuleLink` below it, living as long as this host: wrap a
 * surface whose rows a refresh can re-render or drop, so the sheet outlives the row that
 * opened it.
 */
export function RuleSheetHost({ children }: { children?: React.ReactNode }) {
  const host = useRuleSheet();
  return <RuleSheetScope host={host}>{children}</RuleSheetScope>;
}

export interface RuleLinkProps {
  /** The exact rule value as shown (a rule id or name). Untrusted; rendered as text. */
  rule: string;
  /** The window of the surface it sits on (default: the last 3 days). */
  window?: RuleSheetWindow;
  /** Restrict the sheet's alert figures to one source. */
  sourceId?: string;
  /** Where it is, read after "From " in the sheet: "CASE-000214", "Logs". */
  origin?: string;
  /** Visible text when it is not the value itself (the value still names the link). */
  children?: React.ReactNode;
  /** A native tooltip, for a host that truncates the link (the full value). */
  title?: string;
  className?: string;
}

/**
 * The visible look: inline mono text in the host's size and colour with a quiet dotted
 * underline at rest (so it reads as something to open next to plain values, with no hover
 * on a phone), a solid underline on hover and focus, a 2px ring on keyboard focus with no
 * offset (no halo on a panel), and the opened mark while its sheet is open.
 */
const LINK =
  'inline min-w-0 cursor-pointer rounded-sm bg-transparent p-0 text-left font-mono ' +
  '[overflow-wrap:anywhere] underline decoration-dotted decoration-muted-foreground underline-offset-2 ' +
  'decoration-from-font hover:decoration-solid hover:decoration-current ' +
  'focus-visible:decoration-solid focus-visible:decoration-current focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring ' +
  'aria-[current=true]:bg-primary/10 aria-[current=true]:decoration-solid aria-[current=true]:decoration-current';

function RuleLinkButton({
  host,
  rule,
  window: range,
  sourceId,
  origin,
  children,
  title,
  className,
}: RuleLinkProps & { host: UseRuleSheet }) {
  const linkId = React.useId();
  const ref = React.useRef<HTMLButtonElement>(null);
  // Under a shared host, only the link that opened the sheet is marked as open.
  const opened = host.isOpen && host.openLinkId === linkId;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Open rule ${rule}`}
      aria-haspopup="dialog"
      aria-expanded={opened}
      aria-controls={opened ? host.sheetId : undefined}
      aria-current={opened ? 'true' : undefined}
      data-rule-link=""
      data-rule-host={host.hostId}
      title={title}
      className={cn(LINK, className)}
      onClick={(event) => {
        // A row or card that opens on click must not open too.
        event.stopPropagation();
        host.open({ rule, window: range, sourceId, origin }, ref.current, linkId);
      }}
      onKeyDown={(event) => {
        // Enter and Space belong to this button, never to a row shortcut handler.
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
    >
      {children ?? rule}
    </button>
  );
}

/** A link with no host above it renders its own sheet (it closes when the link goes). */
function RuleLinkWithOwnSheet(props: RuleLinkProps) {
  const host = useRuleSheet();
  return (
    <>
      <RuleLinkButton {...props} host={host} />
      {host.sheet}
    </>
  );
}

export function RuleLink(props: RuleLinkProps) {
  const shared = React.useContext(RuleSheetHostContext);
  if (!isRuleValue(props.rule)) {
    return <span className={cn('font-mono [overflow-wrap:anywhere]', props.className)}>{props.rule}</span>;
  }
  return shared ? <RuleLinkButton {...props} host={shared} /> : <RuleLinkWithOwnSheet {...props} />;
}

export default RuleLink;
