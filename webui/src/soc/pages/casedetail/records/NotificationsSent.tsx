/**
 * The notifications sent for a case (Round 16 SPEC §4.5 WP14, research data-visibility
 * R15): the newest five, then "Show all (N)", each line with its channel type, the
 * trigger, whether it went out (with the delivery detail when it failed), when, and the
 * channel id. A drop-in for the inspector's Record list (WP16 mounts it in place of the
 * inline list in `FactsRail.tsx`).
 *
 * The channel id is our own configuration; the delivery detail is operator or provider
 * text. Both are plain text nodes (#9).
 */
import * as React from 'react';

import { humanizeAge, humanizeToken } from '@/lib/format';
import type { NotificationSendRecord } from '@/lib/types';

/** How many lines show before "Show all". */
export const NOTIFICATIONS_PREVIEW = 5;

export interface NotificationsSentProps {
  records: readonly NotificationSendRecord[] | null | undefined;
}

export const NotificationsSent: React.FC<NotificationsSentProps> = ({ records }) => {
  const [showAll, setShowAll] = React.useState(false);
  const list = Array.isArray(records) ? [...records].reverse() : [];
  if (!list.length) return null;
  const shown = showAll ? list : list.slice(0, NOTIFICATIONS_PREVIEW);
  return (
    <div className="space-y-1" data-testid="facts-notifications">
      <span className="block text-xs font-medium text-muted-foreground">
        {`Notifications sent (${list.length.toLocaleString('en-US')})`}
      </span>
      <ol className="space-y-1 text-xs">
        {shown.map((n, index) => (
          <li key={`${n.ts ?? ''}-${n.channel_id ?? ''}-${index}`} className="text-foreground">
            {humanizeToken(String(n.type || 'channel'))}
            <span className="text-muted-foreground">
              {n.trigger ? ` · ${humanizeToken(n.trigger)}` : ''}
              {` · ${n.ok ? 'sent' : 'failed'}`}
              {!n.ok && n.detail ? ` (${n.detail})` : ''}
              {n.ts ? ` · ${humanizeAge(n.ts)}` : ''}
            </span>
            {n.channel_id ? (
              <span className="block truncate font-mono text-2xs text-muted-foreground" title={n.channel_id}>
                {n.channel_id}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {list.length > NOTIFICATIONS_PREVIEW ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {showAll ? 'Show fewer' : `Show all (${list.length.toLocaleString('en-US')})`}
        </button>
      ) : null}
    </div>
  );
};
