/**
 * An item's answer blocks on screen, through WP-J's LAZY `AnswerBlocks` entry (SPEC
 * §10.10: the blocks and charts are their own chunk; the report UI reaches them only via
 * `import()`, never statically — `chat-blocks-bundle.test.ts` guards that).
 *
 * Reports are read-only views of snapshots: no "Add to report" control, and markdown
 * blocks render through the chat Markdown subset.
 */
import * as React from 'react';

import { LoadingState } from '@/design-system';

import { ChatMarkdown } from '../ChatMarkdown';
import type { AnswerBlock } from '../blocks/schema';
import { EMPTY_LOOKUP_TEXT } from './model';

const AnswerBlocks = React.lazy(() => import('../blocks/AnswerBlocks'));

export interface ItemBlocksProps {
  blocks: AnswerBlock[];
  /** The source assistant message (a data attribute only). */
  messageId: string;
  /** Heading level the block titles sit under (markdown headings follow). */
  headingBase?: number;
  compact?: boolean;
  /** The item's stored block had nothing to show (dropped as `empty`): say so plainly. */
  foundNothing?: boolean;
}

export function ItemBlocks({ blocks, messageId, headingBase = 4, compact = false, foundNothing = false }: ItemBlocksProps) {
  const renderMarkdown = React.useCallback(
    (text: string) => <ChatMarkdown text={text} headingBase={headingBase} />,
    [headingBase],
  );
  if (!blocks.length) {
    return <p className="text-xs text-muted-foreground">{foundNothing ? EMPTY_LOOKUP_TEXT : 'Nothing to show for this item.'}</p>;
  }
  return (
    <React.Suspense fallback={<LoadingState label="Loading report item" layout="inline" />}>
      <AnswerBlocks blocks={blocks} messageId={messageId} compact={compact} canAddToReport={false} renderMarkdown={renderMarkdown} />
    </React.Suspense>
  );
}
