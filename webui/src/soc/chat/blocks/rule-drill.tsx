/**
 * Rule drills inside an answer (Round 14, SPEC §4.6.3, §4.6.5): a rule row of a chat
 * table, a rule bar of a chart, a rule in a severity breakdown or a case's Rules fact
 * opens the ONE rule sheet (`RuleSheet`, through `RuleLink` / `useRuleSheet`).
 *
 * - {@link RuleDrillScope} gives every rule link in a block card one shared sheet host,
 *   so the sheet belongs to the card (it stays open while the transcript re-renders) and
 *   only the link that opened it is marked open. A nested card (a Brief's leaf) shares
 *   the outer card's host; a modal layer (the Expand sheet, "View all rows") has its own.
 * - {@link DrillNavigation} makes the blocks' one `navigate` open a rule ref as that sheet
 *   (a chart bar on click and Enter, `context.tsx`), and remembers the answer before any
 *   other drill leaves it ("Back to answer" on Logs). {@link useRuleDrill} hands the host
 *   to a surface that marks what it opened (the bar whose sheet is open).
 * - The answer is remembered only when a drill really leaves it: a route drill as it goes,
 *   and from a rule sheet only when a link in that sheet is followed ("Open all in Logs",
 *   "Show the cases", a case). Opening a sheet and closing it again remembers nothing, so
 *   a later visit to Logs from the navigation never offers a way back to the answer.
 * - {@link ruleSheetTarget} turns a validated {@link RuleRef} (built by the server from
 *   the exact value events carry, re-validated by `parseBlocks`) into the sheet's target:
 *   the rule, the answer's window and source, and "From your answer" in its header.
 *
 * Every rule value is untrusted source text (#9): `RuleLink` renders it as a text node
 * and an attribute value only, and refuses a value outside the rule grammar.
 */
import * as React from 'react';

import { rememberAnswerOrigin, type AnswerLocation } from '@/soc/answer-origin';
import {
  RuleLink,
  RuleSheetScope,
  useRuleSheet,
  type RuleSheetTarget,
  type UseRuleSheet,
} from '@/soc/components/RuleLink';

import { BlocksContext, useBlocks, type BlocksContextValue } from './context';
import { isRuleRef, type DrillRef, type RuleRef } from './schema';

/** Read after "From " in the sheet's header. */
export const ANSWER_ORIGIN = 'your answer';

/** The rule sheet's target for a validated rule ref (`origin` read after "From "). */
export function ruleSheetTarget(ref: RuleRef, origin: string = ANSWER_ORIGIN): RuleSheetTarget {
  const { rule, from, to, sourceId } = ref.opts;
  return {
    rule,
    // All time has no bounds: the sheet then opens on its own default window.
    window: from ? { from, to: to ?? 'now' } : undefined,
    sourceId,
    origin,
  };
}

const RuleDrillContext = React.createContext<UseRuleSheet | null>(null);

function OwnRuleDrillScope({ children }: { children?: React.ReactNode }) {
  const host = useRuleSheet();
  const { answer } = useBlocks();
  useRememberOnSheetLink(host.isOpen ? host.sheetId : null, answer);
  return (
    <RuleDrillContext.Provider value={host}>
      <RuleSheetScope host={host}>{children}</RuleSheetScope>
    </RuleDrillContext.Provider>
  );
}

/**
 * While the card's rule sheet is open, a plain click on an in-app link inside it (its
 * "Open all in Logs", "Show the cases" or a case) leaves the answer: remember it first, so
 * the page that link opens can offer "Back to answer". Listened for on the document in the
 * capture phase, so it runs before the sheet's own handler closes the sheet and navigates;
 * a modified click (a new tab) leaves this page where it is and remembers nothing.
 */
function useRememberOnSheetLink(sheetId: string | null, answer: AnswerLocation | undefined): void {
  React.useEffect(() => {
    if (!sheetId || typeof document === 'undefined') return undefined;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[href]');
      const sheet = document.getElementById(sheetId);
      if (!link || !sheet?.contains(link) || !(link.getAttribute('href') ?? '').startsWith('#/')) return;
      rememberAnswerOrigin(answer);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [sheetId, answer]);
}

/**
 * One rule sheet for every rule link below it (a block card). Inside another scope it
 * adds nothing: the outer card's sheet serves its leaves too. `layer` starts a scope of
 * its own for content in a modal layer (the card's Expand sheet, a "View all rows"
 * dialog), so the rule sheet opens as a dialog nested inside that layer and closes with it.
 */
export function RuleDrillScope({ children, layer = false }: { children?: React.ReactNode; layer?: boolean }) {
  const outer = React.useContext(RuleDrillContext);
  return outer && !layer ? <>{children}</> : <OwnRuleDrillScope>{children}</OwnRuleDrillScope>;
}

/** The card's rule sheet host, or null outside a {@link RuleDrillScope} (print, exports). */
export function useRuleDrill(): UseRuleSheet | null {
  return React.useContext(RuleDrillContext);
}

/**
 * Open the rule sheet for `ref` from the card's host; false when there is no host (print,
 * a static export) or the value cannot be a rule. `opener` gets focus back when the sheet
 * closes (a chart's plot). Opening it leaves nothing: the answer is remembered only when a
 * link in the sheet is followed (see the scope).
 */
export function openRuleDrill(host: UseRuleSheet | null, ref: RuleRef, opener?: HTMLElement | null): boolean {
  if (!host) return false;
  return host.open(ruleSheetTarget(ref), opener ?? null);
}

/**
 * The blocks' `navigate` for everything below it: a rule ref opens the card's rule sheet
 * (never the router), any other target remembers the answer it leaves and then goes on to
 * the outer navigation (the router, or the host's own).
 */
export function DrillNavigation({ children }: { children?: React.ReactNode }) {
  const outer = useBlocks();
  const host = useRuleDrill();
  const value = React.useMemo<BlocksContextValue>(
    () => ({
      ...outer,
      navigate: (ref: DrillRef, opener?: HTMLElement | null) => {
        if (isRuleRef(ref)) {
          openRuleDrill(host, ref, opener ?? activeElement());
          return;
        }
        rememberAnswerOrigin(outer.answer);
        // Pass the opener on only when there is one (the host's own handler sees exactly
        // what the block handed over).
        if (opener === undefined) outer.navigate(ref);
        else outer.navigate(ref, opener);
      },
    }),
    [outer, host],
  );
  return <BlocksContext.Provider value={value}>{children}</BlocksContext.Provider>;
}

/** The focused element, to give focus back to when a sheet opened by a key closes. */
function activeElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

export interface AnswerRuleLinkProps {
  /** The validated rule ref (the sheet's target). */
  target: RuleRef;
  /** Where it was opened, after "From " ("CASE-000214"); "your answer" by default. */
  origin?: string;
  /** Visible text when it is not the rule value itself (the display-safe label). */
  children?: React.ReactNode;
  className?: string;
  /** A native tooltip for a host that truncates the link (the full value). */
  title?: string;
}

/**
 * A rule name in an answer that opens its rule sheet: the shared `RuleLink` (inline mono,
 * a quiet dotted underline, "Open rule <value>"), on the card's sheet host.
 */
export function AnswerRuleLink({ target, origin, children, className, title }: AnswerRuleLinkProps) {
  const t = ruleSheetTarget(target, origin);
  return (
    <RuleLink rule={t.rule} window={t.window} sourceId={t.sourceId} origin={t.origin} className={className} title={title}>
      {children}
    </RuleLink>
  );
}
