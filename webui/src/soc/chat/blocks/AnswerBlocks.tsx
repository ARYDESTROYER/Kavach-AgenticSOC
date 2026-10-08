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
 *   - Consecutive `entity` blocks are laid out as a 2-column grid from ~48rem.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';

import { BlockBoundary } from './BlockBoundary';
import { BlockCard } from './BlockCard';
import { BlocksContext, domSafe, leafAnchorKey, useRouterNavigate, type BlocksContextValue } from './context';
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

type Group = { kind: 'single'; index: number } | { kind: 'entities'; indices: number[] };

function groupBlocks(blocks: readonly AnswerBlock[]): Group[] {
  const out: Group[] = [];
  blocks.forEach((b, i) => {
    const last = out[out.length - 1];
    if (b.type === 'entity' && last && last.kind === 'entities') last.indices.push(i);
    else if (b.type === 'entity' && blocks[i + 1]?.type === 'entity') out.push({ kind: 'entities', indices: [i] });
    else out.push({ kind: 'single', index: i });
  });
  return out;
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
  className,
}: AnswerBlocksProps) {
  const routerNavigate = useRouterNavigate();
  const rawId = React.useId();
  const prefix = domId ? domSafe(domId) : `msg${domSafe(rawId)}`;
  const navigate = onNavigate ?? routerNavigate;
  const list = Array.isArray(blocks) ? blocks : [];
  const citationOwner = citationOwnerKey(list);
  const ctx = React.useMemo<BlocksContextValue>(
    () => ({ navigate, compact, domId: prefix, renderMarkdown, queryForStep, citationOwner: citationOwner ?? '' }),
    [navigate, compact, prefix, renderMarkdown, queryForStep, citationOwner],
  );
  if (!list.length) return null;

  const card = (b: AnswerBlock, i: number) => (
    <BlockBoundary key={`${i}-${b.id}`} id={b.id} fallbackText={b.fallback_text}>
      <BlockCard
        block={b}
        index={i}
        inReport={inReport?.has(b.id) ?? false}
        canAddToReport={canAddToReport && b.type !== 'callout' && b.type !== 'markdown'}
        onAddToReport={onAddToReport ? () => onAddToReport(b.id) : undefined}
        addDisabledReason={addDisabledReason}
      />
    </BlockBoundary>
  );

  return (
    <BlocksContext.Provider value={ctx}>
      <div
        className={cn('flex min-w-0 flex-col gap-3', className)}
        data-testid="answer-blocks"
        data-message-id={MESSAGE_ID_RE.test(messageId) ? messageId : undefined}
      >
        {groupBlocks(list).map((g) =>
          g.kind === 'single' ? (
            card(list[g.index], g.index)
          ) : (
            <div key={`ents-${g.indices[0]}`} className="@container min-w-0">
              <div className="grid grid-cols-1 gap-3 @[48rem]:grid-cols-2">{g.indices.map((i) => card(list[i], i))}</div>
            </div>
          ),
        )}
      </div>
    </BlocksContext.Provider>
  );
}

export default AnswerBlocks;
