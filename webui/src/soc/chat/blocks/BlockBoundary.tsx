/**
 * The per-block error boundary (G9: never blank the message).
 *
 * A renderer that throws is replaced by the quiet fallback notice WITH the block's own
 * plain `fallback_text` when it carried one, so the reader still gets the summary the
 * server wrote for exactly this case. It wraps every top-level block (AnswerBlocks) and
 * every leaf inside a report section (BlockCard), so one broken leaf never takes the
 * whole Brief down with it.
 */
import * as React from 'react';

import { CalloutView } from './renderers/SimpleViews';
import { fallbackBlock } from './schema';

export interface BlockBoundaryProps {
  /** The failing block's id (used only inside the fallback block, never as a DOM id). */
  id: string;
  /** The block's own plain-text summary (G9), shown under the notice. */
  fallbackText?: string;
  children: React.ReactNode;
}

export class BlockBoundary extends React.Component<BlockBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) return <CalloutView block={fallbackBlock(this.props.id, this.props.fallbackText)} />;
    return this.props.children;
  }
}
