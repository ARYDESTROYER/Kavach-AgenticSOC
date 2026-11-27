/**
 * CaseDetail: the Activity tab, id `collab` (Round 16, SPEC D8, §4.4 WP03; the
 * Collaboration tab before it).
 *
 * The people side of a case (#4), in three sections divided by hairlines:
 *
 *   Discussion  the case thread (AI is a first-class author but can only RECOMMEND)
 *   Files       the screenshots on the case (D5.12): the caller's gallery and drop zone
 *               (`renderFiles`, the lazy `CaseFiles`), given this tab as the scope a
 *               pasted image is caught in, with its count beside the heading
 *   History     the lifecycle with who, when and the actions taken, from the case's own
 *               history (D4.2), and the full who-did-what activity feed one click away
 *
 * The case's tasks are on the Response tab (Round 16): this tab no longer points there.
 * There is no owner picker here: the owner's one editable home is the header (D8.2).
 * From a 52rem pane the discussion and files take the main column and the history a side
 * column; narrower, the sections stack. The layout follows the PANE width (container
 * queries), never the viewport.
 *
 * SECURITY (#9): thread bodies, task titles, names, notes and activity summaries are all
 * UNTRUSTED, rendered as plain text inside the child components. #3-safe: nothing here
 * changes the case decision (the backend enforces this).
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import type { Case } from '@/lib/types';
import type { StreamEvent } from '@/lib/useEventStream';
import { cn } from '@/lib/cn';

import { Skeleton } from '@/ui/skeleton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { LoadingBar } from '@/design-system';

import { CaseThread, visibleMessageCount } from '@/soc/components/CaseThread';
import { CaseActivityFeed } from '@/soc/components/CaseActivityFeed';
import { LoadError } from '@/soc/components/LoadError';
import type {
  CaseMessage as ThreadMessage,
  CaseActivityItem,
  PickableUser,
} from '@/soc/pages/CaseDetail.api';

import { CaseHistory } from './CaseHistory';
import { CASE_MANAGER_PANEL_PADDING, PanelSection } from './shared';

// Kept for existing importers: the owner picker lives in the header since Round 15.
export { AssigneePicker, assigneeSelectValue } from './AssigneePicker';

export const CollaborationThreadTab: React.FC<{
  c: Case;
  thread: ThreadMessage[] | null;
  threadLoading: boolean;
  threadError: unknown;
  threadBusyId: string | null;
  activity: CaseActivityItem[] | null;
  activityLoading: boolean;
  activityError: unknown;
  users: PickableUser[];
  currentUser: string | null;
  canComment: boolean;
  onRetryThread: () => void;
  onRetryActivity: () => void;
  onPost: (text: string) => void;
  onReply: (parentId: string, text: string) => void;
  onEdit: (msgId: string, text: string) => void;
  onDelete: (msgId: string) => void;
  onReact: (msgId: string, emoji: string, remove: boolean) => void;
  /**
   * Round 15 (D5.12): the Files section's body (the WP4 gallery, its drop zone and file
   * picker), given this tab as the scope where a pasted image is caught. Omitted: no
   * Files section.
   */
  renderFiles?: (pasteScope: React.RefObject<HTMLElement | null>) => React.ReactNode;
  /** Beside the Files heading: the screenshot count ("2 of 20"). */
  filesAdornment?: React.ReactNode;
  /**
   * Optional LIVE wiring (Wave 4): when set, the thread + activity feed subscribe to
   * the per-case SSE room and nudge the caller to refetch on a `case.activity` frame
   * (realtime is still default-OFF on the backend → polling fallback otherwise). The
   * thread's nudge carries its frame, so one naming a screenshot refreshes the Files
   * section instead (Round 15).
   */
  liveCaseId?: string;
  onLiveThread?: (event?: StreamEvent) => void;
  onLiveActivity?: () => void;
}> = ({
  c,
  thread,
  threadLoading,
  threadError,
  threadBusyId,
  activity,
  activityLoading,
  activityError,
  users,
  currentUser,
  canComment,
  onRetryThread,
  onRetryActivity,
  onPost,
  onReply,
  onEdit,
  onDelete,
  onReact,
  renderFiles,
  filesAdornment,
  liveCaseId,
  onLiveThread,
  onLiveActivity,
}) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [activityOpen, setActivityOpen] = React.useState(false);
  // Count the SAME set CaseThread renders (drop tombstoned roots with no replies) so the
  // count can never over-count the visible list.
  const visible = thread ? visibleMessageCount(thread) : 0;
  const files = renderFiles ? renderFiles(rootRef) : null;

  return (
    <div
      ref={rootRef}
      className={cn('@container/collab min-w-0', CASE_MANAGER_PANEL_PADDING)}
      data-case-panel="collaboration"
      data-presentation="case-manager"
    >
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 @[52rem]/collab:grid-cols-[minmax(0,1fr)_18rem] @[52rem]/collab:gap-8"
        data-testid="case-tab-first"
      >
        {/* ------------------------------------------- main: discussion and files */}
        <div className="min-w-0 space-y-6">
          <PanelSection
            title="Discussion"
            adornment={
              visible ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {visible} message{visible === 1 ? '' : 's'}
                </span>
              ) : null
            }
          >
            <div data-collaboration-surface="discussion-canvas" className="flex min-w-0 flex-col">
              <LoadingBar
                active={threadLoading && thread !== null}
                size="sm"
                label="Refreshing discussion"
                className="mb-3"
              />
              {threadLoading && thread === null ? (
                <div className="space-y-3">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : threadError && thread === null ? (
                <LoadError
                  error={threadError}
                  title="Could not load discussion"
                  fallback="The shared case discussion is temporarily unavailable."
                  retryLabel="Retry discussion"
                  onRetry={onRetryThread}
                />
              ) : (
                <>
                  {threadError ? (
                    <LoadError
                      error={threadError}
                      title="Could not refresh discussion"
                      fallback="The last loaded discussion remains visible."
                      retryLabel="Retry discussion"
                      onRetry={onRetryThread}
                      className="mb-3"
                    />
                  ) : null}
                  <CaseThread
                    messages={thread || []}
                    users={users}
                    currentUser={currentUser}
                    canComment={canComment}
                    busyId={threadBusyId}
                    onPost={onPost}
                    onReply={onReply}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onReact={onReact}
                    liveCaseId={liveCaseId}
                    onLiveActivity={onLiveThread}
                    className={cn(
                      'flex flex-1 flex-col [&>div:first-child]:flex-1 @[52rem]/collab:min-h-[24rem]',
                      canComment &&
                        '[&>div:last-child]:mt-auto [&>div:last-child]:rounded-none [&>div:last-child]:border-x-0 [&>div:last-child]:border-b-0 [&>div:last-child]:border-t [&>div:last-child]:border-border/60 [&>div:last-child]:bg-transparent [&>div:last-child]:px-0 [&>div:last-child]:pb-0 [&>div:last-child]:pt-4',
                    )}
                  />
                </>
              )}
            </div>
          </PanelSection>

          {files ? (
            <PanelSection title="Files" section="files" testId="collaboration-files" adornment={filesAdornment}>
              {files}
            </PanelSection>
          ) : null}
        </div>

        {/* ------------------------------------------------- side: the history */}
        {/* A plain column: its History section is the labelled region (an aside here would
            be a complementary landmark nested in the case's region). */}
        <div
          data-collaboration-surface="context-rail"
          className="min-w-0 space-y-6 border-t border-border/60 pt-6 @[52rem]/collab:border-l @[52rem]/collab:border-t-0 @[52rem]/collab:pl-6 @[52rem]/collab:pt-0"
        >
          <PanelSection title="History" testId="collaboration-history">
            <CaseHistory c={c} />
            <Collapsible
              open={activityOpen}
              onOpenChange={(open) => {
                setActivityOpen(open);
                // The feed listens live only while it is open: opening it re-reads it, so
                // what it shows is current.
                if (open && activity !== null && !activityLoading) onRetryActivity();
              }}
              className="space-y-3 pt-1"
            >
              <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', activityOpen && 'rotate-180')} aria-hidden />
                {activityOpen ? 'Hide all activity' : 'Show all activity'}
                {activityError && !activityOpen ? (
                  <span className="font-normal text-critical-text">· could not load</span>
                ) : null}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Every recorded action on this case: lifecycle changes, comments, runbook steps and the
                  agent&apos;s work.
                </p>
                <LoadingBar
                  active={activityLoading && activity !== null}
                  size="sm"
                  label="Refreshing case activity"
                />
                {activityError ? (
                  <LoadError
                    error={activityError}
                    title={activity === null ? 'Could not load activity' : 'Could not refresh activity'}
                    fallback="The authoritative case timeline is temporarily unavailable."
                    retryLabel="Retry activity"
                    onRetry={onRetryActivity}
                  />
                ) : null}
                {activityError && activity === null ? null : (
                  <CaseActivityFeed
                    items={activity || []}
                    loading={activityLoading && activity === null}
                    liveCaseId={liveCaseId}
                    onLiveActivity={onLiveActivity}
                  />
                )}
              </CollapsibleContent>
            </Collapsible>
          </PanelSection>
        </div>
      </div>
    </div>
  );
};

export default CollaborationThreadTab;
