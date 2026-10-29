/**
 * The rule sheet's module store (Round 14, SPEC §4.6.5): ONE open rule sheet for the
 * whole Console, whichever surface opened it.
 *
 * A `RuleLink` (or any host using `useRuleSheet`) asks the store to open a rule; the store
 * keeps the one request, so opening a second rule replaces the first. The request names
 * the host that renders the lazy sheet, so the sheet sits in that host's React tree:
 * inside a case sheet it is a nested dialog of that sheet. A surface that refreshes on its
 * own (a live tail, a LIVE dashboard, a list that re-ranks) gives its links one shared host
 * (`RuleSheetHost`), so the sheet stays open while the row that opened it re-renders or
 * leaves the list, and closes only when the surface itself goes (a navigation). Focus goes
 * back to the element that opened it, or, when that element is gone, to the same rule's
 * link in the same host, else to the dialog or region it sat in.
 *
 * Entry-safe and tiny: no React import, no module-level work besides the empty state.
 * Every rule value is untrusted text (#9); it is carried as data and validated with the
 * server's rule grammar before a sheet opens.
 */

/** A time window for the sheet, in the `TimeRangePicker` shape (`now-3d`/`now`, or ISO bounds). */
export interface RuleSheetWindow {
  from: string;
  to: string;
  /** How the window reads ("Last 3 days"); derived when absent. */
  label?: string;
}

/** What a host asks the sheet to show. */
export interface RuleSheetTarget {
  /** The exact rule value as shown (a rule id or name), never trimmed. */
  rule: string;
  /** The window of the surface that opened it; the sheet defaults to the last 3 days. */
  window?: RuleSheetWindow;
  /** Restrict the alert sections to one source. */
  sourceId?: string;
  /**
   * Where it was opened, read after "From " in the sheet header: "your answer",
   * "CASE-000214", "Logs". Plain text.
   */
  origin?: string;
}

/** The one open request. */
export interface RuleSheetRequest extends RuleSheetTarget {
  /** The host that renders the sheet (a `useRuleSheet` instance). */
  hostId: string;
  /** Increases with every open, so reopening the same rule is a new request. */
  seq: number;
  /** The link that opened it, when a link did: only that link is marked as open. */
  linkId?: string;
}

/**
 * The server's rule grammar (`engine.log_rows.valid_rule_value`, the router's `rule`
 * deep-link validator): 1 to 256 code points on one line, none of them a control,
 * format, surrogate, private-use or unassigned character, or a line or paragraph
 * separator. Never trimmed: the value is the exact text to match.
 */
const RULE_VALUE_RE = /^[^\p{C}\u2028\u2029]{1,256}$/u;

/** Whether `value` is a rule value the sheet can open (see {@link RULE_VALUE_RE}). */
export function isRuleValue(value: unknown): value is string {
  return typeof value === 'string' && RULE_VALUE_RE.test(value);
}

type Listener = () => void;

/** Where focus goes back to when a host's sheet closes. */
interface ReturnFocus {
  /** The element that opened the sheet. */
  opener: HTMLElement | null;
  /** The dialog the opener sat in, if any (a case sheet, an inspector). */
  container: HTMLElement | null;
  /** The rule that was opened, to find its link again when a refresh re-rendered it. */
  rule: string;
}

let current: RuleSheetRequest | null = null;
let seq = 0;
const listeners = new Set<Listener>();
/** Where to give focus back to on close, by host. */
const returnFocus = new Map<string, ReturnFocus>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to the store (the `useSyncExternalStore` contract). */
export function subscribeRuleSheet(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open request, or null. */
export function getRuleSheetRequest(): RuleSheetRequest | null {
  return current;
}

/**
 * Open the sheet for `target`, rendered by `hostId`. A value the server would refuse is
 * ignored (nothing opens). Replaces any sheet already open. `linkId` names the link that
 * opened it, so a host shared by many links marks only that one.
 */
export function openRuleSheet(
  target: RuleSheetTarget,
  hostId: string,
  opener?: HTMLElement | null,
  linkId?: string,
): boolean {
  if (!isRuleValue(target.rule) || !hostId) return false;
  seq += 1;
  returnFocus.clear();
  returnFocus.set(hostId, {
    opener: opener ?? null,
    container: opener?.closest<HTMLElement>('[role="dialog"]') ?? null,
    rule: target.rule,
  });
  current = {
    rule: target.rule,
    window: target.window,
    sourceId: target.sourceId || undefined,
    origin: target.origin || undefined,
    hostId,
    seq,
    linkId: linkId || undefined,
  };
  emit();
  return true;
}

/** Close the sheet. With `hostId`, only when that host's request is the open one. */
export function closeRuleSheet(hostId?: string): void {
  if (!current) return;
  if (hostId && current.hostId !== hostId) return;
  current = null;
  emit();
}

/**
 * The same rule's link in the same host, when a refresh re-rendered the row that opened
 * the sheet (a new element with the same name). Compared as text, never as a selector, so
 * an untrusted rule value is never parsed as CSS.
 */
function findRuleLink(hostId: string, rule: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const name = `Open rule ${rule}`;
  for (const element of document.querySelectorAll<HTMLElement>('[data-rule-link]')) {
    if (element.dataset.ruleHost === hostId && element.getAttribute('aria-label') === name) return element;
  }
  return null;
}

/**
 * The element to give focus back to when `hostId`'s sheet closes (and forget it): the
 * opener while it is still on the screen; else the same rule's link in the same host (the
 * row was re-rendered by a refresh); else the dialog the opener sat in while it is still
 * open. Null when none of them is on the screen (the caller then falls back to the main
 * region). Only a connected element is ever returned.
 */
export function takeRuleSheetReturnFocus(hostId: string): HTMLElement | null {
  const entry = returnFocus.get(hostId);
  returnFocus.delete(hostId);
  if (!entry) return null;
  if (entry.opener?.isConnected) return entry.opener;
  const link = findRuleLink(hostId, entry.rule);
  if (link) return link;
  return entry.container?.isConnected ? entry.container : null;
}

/**
 * A modal owns the keyboard (SPEC §3.3): a key typed in the sheet never reaches the
 * single-letter shortcuts of the surface behind it (a case's A, C, E, R, Alt+1), whether
 * they listen on the document or on a React ancestor of the opener. Esc and Tab stay with
 * the dialog's own handling (close, focus trap), and a Ctrl or Cmd chord (the command
 * palette) still reaches the shell. Use as the sheet content's `onKeyDown`.
 */
export function keepKeysInSheet(event: { key: string; ctrlKey: boolean; metaKey: boolean; stopPropagation: () => void }): void {
  if (event.key === 'Escape' || event.key === 'Tab' || event.ctrlKey || event.metaKey) return;
  event.stopPropagation();
}

/** Reset the store between tests. */
export function resetRuleSheetStoreForTests(): void {
  current = null;
  seq = 0;
  returnFocus.clear();
  emit();
}
