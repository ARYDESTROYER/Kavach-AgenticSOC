/**
 * AnswerBlocks — the LAZY entry of the answer-blocks kit (SPEC §7, §10.3, §10.10).
 *
 * Load it with `React.lazy(() => import('@/soc/chat/blocks/AnswerBlocks'))`: the blocks
 * and every chart live in this one chunk, never in the Workspace route chunk or the
 * eager entry. Nothing here imports recharts, `components/charts.tsx` or
 * `components/charts-soc.tsx` (guarded by `chat-blocks-bundle.test.ts`).
 *
 * Contract:
 *   - `blocks` must come from `parseBlocks()` (schema.ts): validated, display-sanitised,
 *     clamped. Renderers still never throw past this component — a renderer error is
 *     caught per block and replaced by the quiet fallback notice (G9: never blank the
 *     message).
 *   - Strings render as React text nodes only; no string from a block reaches `href`,
 *     `style`, `className`, a DOM id or `token()` (G1, G2). DOM ids come from
 *     `React.useId()` plus the block index, never `block.id`.
 *   - The only actions are navigation through validated refs, copy and download (G10).
 *   - Consecutive `entity` blocks are laid out as a 2-column grid from ~48rem (the pair
 *     spans the lane: it is marked wide).
 *   - Round 13 (SPEC-chat §5.1, T7, T8): every card carries `data-block-width`
 *     (`compact` | `wide`, `layout.ts`), which the lane uses to keep compact cards in the
 *     42rem reading column; and, with `shareCaptions`, the caption parts two or more
 *     cards repeat (with the same "as of" minute) are stated ONCE in a scope line above
 *     the first of them, each card keeping its other parts. Display only: the blocks are
 *     never changed, so print, exports, Add to report and the expanded sheet keep every
 *     card's full caption.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';

import { BlockBoundary } from './BlockBoundary';
import { BlockCard } from './BlockCard';
import { BlocksContext, domSafe, leafAnchorKey, useRouterNavigate, type BlocksContextValue } from './context';
import { blockGroups, blockWidth, sharedScope } from './layout';
import type { AnswerBlock, InternalRef } from './schema';

export interface AnswerBlocksProps {
  blocks: AnswerBlock[];
  /** The assistant message these blocks belong to (data attribute only; never a DOM id). */
  messageId: string;
  /** Case Manager embed density. */
  compact?: boolean;
  /** Block ids already in the conversation's report ("In report ✓"). */
  inReport?: ReadonlySet<string>;
  /** Toggle a block in the report (the host decides add vs remove). */
  onAddToReport?: (blockId: string) => void;
  /** Show the Add to report control (false for case scope, a full report, a viewer). */
  canAddToReport?: boolean;
  /** Why adding is refused (a full report): the toggles stay, `aria-disabled` with it. */
  addDisabledReason?: string | null;
  /** Navigation for validated refs; defaults to the shell router. */
  onNavigate?: (ref: InternalRef) => void;
  /** Renderer for `markdown` blocks (WP-I's ChatMarkdown); a safe built-in otherwise. */
  renderMarkdown?: (text: string) => React.ReactNode;
  /** The exact query a lookup step ran (`ChatStep.query`), enabling "Copy query". */
  queryForStep?: (step: number) => string | null | undefined;
  /**
   * DOM id prefix for in-message anchors (`<domId>-cite-<n>`), shared with the answer's
   * `[n]` markers. Sanitised; generated from `React.useId()` when omitted.
   */
  domId?: string;
  /** The host frames these blocks already (a report panel item): cards drop their frame. */
  bareCards?: boolean;
  /**
   * State the caption parts several cards repeat ONCE, in a scope line above the first of
   * them (the transcript, SPEC-chat T8). Off by default: a host that shows blocks one by
   * one keeps every caption whole.
   */
  shareCaptions?: boolean;
  className?: string;
}

const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The ONE citations block per message whose items carry the `<domId>-cite-n` anchors the
 * answer's `[n]` markers jump to: the first in document order (a top-level block, else a
 * leaf inside a report). A second citations block would mint the same ids, and
 * `getElementById` would then land on whichever came first in the DOM.
 */
export function citationOwnerKey(blocks: readonly AnswerBlock[]): string | undefined {
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (b.type === 'citations') return leafAnchorKey(i);
    if (b.type === 'report') {
      for (let si = 0; si < b.sections.length; si += 1) {
        const li = b.sections[si].blocks.findIndex((leaf) => leaf.type === 'citations');
        if (li >= 0) return leafAnchorKey(i, `${si}-${li}`);
      }
    }
  }
  return undefined;
}

export function AnswerBlocks({
  blocks,
  messageId,
  compact = false,
  inReport,
  onAddToReport,
  canAddToReport = false,
  addDisabledReason = null,
  onNavigate,
  renderMarkdown,
  queryForStep,
  domId,
  bareCards = false,
  shareCaptions = false,
  className,
}: AnswerBlocksProps) {
  const routerNavigate = useRouterNavigate();
  const rawId = React.useId();
  const prefix = domId ? domSafe(domId) : `msg${domSafe(rawId)}`;
  const navigate = onNavigate ?? routerNavigate;
  const list = React.useMemo(() => (Array.isArray(blocks) ? blocks : []), [blocks]);
  const citationOwner = citationOwnerKey(list);
  const ctx = React.useMemo<BlocksContextValue>(
    () => ({ navigate, compact, domId: prefix, renderMarkdown, queryForStep, citationOwner: citationOwner ?? '' }),
    [navigate, compact, prefix, renderMarkdown, queryForStep, citationOwner],
  );
  const scope = React.useMemo(() => (shareCaptions && !compact ? sharedScope(list) : null), [compact, list, shareCaptions]);
  if (!list.length) return null;
  const scopeAt = scope ? scope.members[0] : -1;

  const card = (b: AnswerBlock, i: number) => (
    <BlockBoundary key={`${i}-${b.id}`} id={b.id} fallbackText={b.fallback_text}>
      <BlockCard
        block={b}
        index={i}
        inReport={inReport?.has(b.id) ?? false}
        canAddToReport={canAddToReport && b.type !== 'callout' && b.type !== 'markdown'}
        onAddToReport={onAddToReport ? () => onAddToReport(b.id) : undefined}
        addDisabledReason={addDisabledReason}
        bare={bareCards}
        width={blockWidth(b)}
        sharedScope={scope && scope.members.includes(i) ? scope : null}
      />
    </BlockBoundary>
  );
  // The answer's one scope line, just above the first card it speaks for (reading column,
  // muted, never framed: the lane caps it and never hangs it).
  const scopeLine = (key: string) =>
    scope ? (
      <p key={key} className="text-xs text-muted-foreground" data-scope-line="" data-testid="answer-scope-line">
        {scope.line}
      </p>
    ) : null;

  return (
    <BlocksContext.Provider value={ctx}>
      <div
        className={cn('flex min-w-0 flex-col gap-3', className)}
        data-testid="answer-blocks"
        data-message-id={MESSAGE_ID_RE.test(messageId) ? messageId : undefined}
      >
        {blockGroups(list).flatMap((g) => {
          const first = g.kind === 'single' ? g.index : g.indices[0];
          const lead = scope && (g.kind === 'single' ? g.index === scopeAt : g.indices.includes(scopeAt)) ? [scopeLine(`scope-${first}`)] : [];
          return [
            ...lead,
            g.kind === 'single' ? (
              card(list[g.index], g.index)
            ) : (
              <div key={`ents-${g.indices[0]}`} className="@container min-w-0" data-block-width="wide">
                <div className="grid grid-cols-1 gap-3 @[48rem]:grid-cols-2">{g.indices.map((i) => card(list[i], i))}</div>
              </div>
            ),
          ];
        })}
      </div>
    </BlocksContext.Provider>
  );
}

export default AnswerBlocks;
