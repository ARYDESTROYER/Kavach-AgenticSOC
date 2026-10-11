/**
 * CaseDetail — Collaboration panel (Coupling-D split).
 *
 * The full collaboration surface for a case (#4): the discussion thread (AI is a
 * first-class author but can only RECOMMEND), an assignee picker, a task checklist,
 * and the activity feed — all over the Round-3 collaboration endpoints. Writes are
 * gated by `canComment` / `canWrite` (the caller passes the resolved RBAC booleans).
 *
 * SECURITY (#9): thread bodies, task titles, assignee ids, activity summaries are all
 * UNTRUSTED — rendered plain text inside the child components. #3-safe: nothing here
 * changes the case decision (the backend enforces this).
 */
import * as React from 'react';
import { History, MessageSquare, RefreshCw, Save, Users } from 'lucide-react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { cn } from '@/lib/cn';

import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { LoadingBar, LoadingState } from '@/design-system';

import { CaseThread, visibleMessageCount } from '@/soc/components/CaseThread';
import { CaseTasks } from '@/soc/components/CaseTasks';
import { CaseActivityFeed } from '@/soc/components/CaseActivityFeed';
import { LoadError } from '@/soc/components/LoadError';
import type {
  CaseMessage as ThreadMessage,
  CaseTask as CaseTaskItem,
  CaseActivityItem,
  PickableUser,
  TaskStatus,
} from '@/soc/pages/CaseDetail.api';

import { CASE_MANAGER_PANEL_PADDING, PanelCard, SectionHeading } from './shared';
import type { CasePanelPresentation } from './shared';

/**
 * The Radix Select value for an assignee picker. Binds to the ACTUAL assignee so the
 * trigger reflects it instead of a false "Unassigned": the known user's CANONICAL
 * username (so it matches a SelectItem exactly even when the stored value differs in
 * case), else the free-text value (rendered as a selectable item), else the
 * "__unassigned__" sentinel when there is no assignee.
 */
export function assigneeSelectValue(current: string, users: PickableUser[]): string {
  const trimmed = (current || '').trim();
  if (!trimmed) return '__unassigned__';
  const matched = users.find((u) => u.username.toLowerCase() === trimmed.toLowerCase());
  return matched?.username ?? trimmed;
}

/** An assignee picker over the known users (with a free-text fallback when the user
 *  store is empty / auth is off). Saves via api.caseAssign + bubbles the updated case
 *  through `onAssigned`. The assignee string is UNTRUSTED → rendered plain. */
export const AssigneePicker: React.FC<{
  c: Case;
  users: PickableUser[];
  canWrite: boolean;
  onAssigned: (next: Case) => void;
}> = ({ c, users, canWrite, onAssigned }) => {
  const current = (c.assignee || '').trim();
  const [free, setFree] = React.useState(current);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setFree(c.assignee || ''), [c.assignee]);

  const save = React.useCallback(
    async (value: string) => {
      setSaving(true);
      try {
        const next = await api.caseAssign(c.case_id, value.trim());
        onAssigned(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save the assignee.');
      } finally {
        setSaving(false);
      }
    },
    [c.case_id, onAssigned],
  );

  // When we have a user list, use a Select; otherwise a free-text input + Save.
  if (users.length) {
    const known = users.some((u) => u.username.toLowerCase() === current.toLowerCase());
    const selectValue = assigneeSelectValue(current, users);
    return (
      <div className="flex items-center gap-2">
        <Select
          value={selectValue}
          disabled={!canWrite || saving}
          onValueChange={(v) => void save(v === '__unassigned__' ? '' : v)}
        >
          <SelectTrigger className="h-9 w-full" aria-label="Assignee">
            <SelectValue placeholder="Unassigned" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unassigned__">Unassigned</SelectItem>
            {/* If the current assignee is a free-text id not in the user list, keep it
                selectable so it isn't silently lost. UNTRUSTED → plain text. */}
            {current && !known ? <SelectItem value={current}>{current}</SelectItem> : null}
            {users.map((u) => (
              <SelectItem key={u.username} value={u.username}>
                {/* UNTRUSTED username — plain text. */}
                {u.username}
                {u.role ? ` · ${u.role}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
    );
  }

  const dirty = free.trim() !== current;
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Unassigned — type to assign…"
        value={free}
        disabled={!canWrite}
        onChange={(e) => setFree(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && dirty) void save(free);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!canWrite || !dirty || saving}
        onClick={() => void save(free)}
      >
        {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save
      </Button>
    </div>
  );
};

export const CollaborationThreadTab: React.FC<{
  c: Case;
  thread: ThreadMessage[] | null;
  threadLoading: boolean;
  threadError: unknown;
  threadBusyId: string | null;
  tasks: CaseTaskItem[] | null;
  tasksLoading: boolean;
  tasksError: unknown;
  tasksBusyId: string | null;
  activity: CaseActivityItem[] | null;
  activityLoading: boolean;
  activityError: unknown;
  users: PickableUser[];
  currentUser: string | null;
  canComment: boolean;
  canWrite: boolean;
  onRetryThread: () => void;
  onRetryTasks: () => void;
  onRetryActivity: () => void;
  onPost: (text: string) => void;
  onReply: (parentId: string, text: string) => void;
  onEdit: (msgId: string, text: string) => void;
  onDelete: (msgId: string) => void;
  onReact: (msgId: string, emoji: string, remove: boolean) => void;
  onAddTask: (title: string) => void;
  onTaskStatus: (taskId: string, status: TaskStatus) => void;
  onTaskLog: (taskId: string, note: string) => void;
  onAssigned: (next: Case) => void;
  /**
   * Optional LIVE wiring (Wave 4): when set, the thread + activity feed subscribe to
   * the per-case SSE room and nudge the caller to refetch on a `case.activity` frame
   * (realtime is still default-OFF on the backend → polling fallback otherwise).
   */
  liveCaseId?: string;
  onLiveThread?: () => void;
  onLiveActivity?: () => void;
  presentation?: CasePanelPresentation;
}> = ({
  c,
  thread,
  threadLoading,
  threadError,
  threadBusyId,
  tasks,
  tasksLoading,
  tasksError,
  tasksBusyId,
  activity,
  activityLoading,
  activityError,
  users,
  currentUser,
  canComment,
  canWrite,
  onRetryThread,
  onRetryTasks,
  onRetryActivity,
  onPost,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onAddTask,
  onTaskStatus,
  onTaskLog,
  onAssigned,
  liveCaseId,
  onLiveThread,
  onLiveActivity,
  presentation = 'default',
}) => {
  const isCaseManager = presentation === 'case-manager';

  return (
    <div
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6',
        isCaseManager
          ? cn(
              'min-h-[32rem] lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-6',
              CASE_MANAGER_PANEL_PADDING,
            )
          : 'p-6 lg:grid-cols-[minmax(0,1fr)_22rem]',
      )}
      data-case-panel={isCaseManager ? 'collaboration' : undefined}
      data-presentation={isCaseManager ? 'case-manager' : undefined}
    >
      {/* -------------------------------------------------- main: the thread */}
      <div className="min-w-0">
        <PanelCard
          data-collaboration-surface={isCaseManager ? 'discussion-canvas' : undefined}
          className={cn(
            isCaseManager &&
              'flex min-h-[32rem] flex-col rounded-none border-0 bg-transparent p-0 shadow-none',
          )}
        >
          <SectionHeading
            icon={MessageSquare}
            actions={(() => {
              // Count the SAME set CaseThread renders (drop tombstoned roots with no
              // replies) so the badge can never over-count vs the visible list.
              const visible = thread ? visibleMessageCount(thread) : 0;
              return visible ? (
                <Badge variant="info">
                  {visible} message{visible === 1 ? '' : 's'}
                </Badge>
              ) : undefined;
            })()}
          >
            Discussion
          </SectionHeading>
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
                  isCaseManager &&
                    'flex min-h-[26rem] flex-1 flex-col [&>div:first-child]:flex-1',
                  isCaseManager &&
                    canComment &&
                    '[&>div:last-child]:mt-auto [&>div:last-child]:rounded-none [&>div:last-child]:border-x-0 [&>div:last-child]:border-b-0 [&>div:last-child]:border-t [&>div:last-child]:border-border/60 [&>div:last-child]:bg-transparent [&>div:last-child]:px-0 [&>div:last-child]:pb-0 [&>div:last-child]:pt-4',
                )}
              />
            </>
          )}
        </PanelCard>
      </div>

      {/* -------------------------------------------------- aside: ownership */}
      {/* Sticky rail on lg+ so ownership/tasks/activity stay in view while the
          thread scrolls; the rail itself scrolls when its own content overflows. */}
      <aside
        data-collaboration-surface={isCaseManager ? 'context-rail' : undefined}
        className={cn(
          'min-w-0 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto',
          isCaseManager ? 'space-y-0 rounded-md bg-muted/20 px-4 py-1' : 'space-y-6',
        )}
      >
        <PanelCard
          data-collaboration-rail-section={isCaseManager ? 'ownership' : undefined}
          className={cn(
            'p-4',
            isCaseManager && 'rounded-none border-0 bg-transparent px-0 py-4 shadow-none',
          )}
        >
          <SectionHeading icon={Users}>
            Ownership
          </SectionHeading>
          <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Assignee
          </Label>
          <AssigneePicker c={c} users={users} canWrite={canWrite} onAssigned={onAssigned} />
        </PanelCard>

        <PanelCard
          data-collaboration-rail-section={isCaseManager ? 'tasks' : undefined}
          className={cn(
            'p-4',
            isCaseManager &&
              'rounded-none border-x-0 border-b-0 border-t border-border/60 bg-transparent px-0 py-4 shadow-none',
          )}
        >
          <LoadingBar
            active={tasksLoading && tasks !== null}
            size="sm"
            label="Refreshing case tasks"
            className="mb-3"
          />
          {tasksLoading && tasks === null ? (
            <LoadingState
              label="Loading case tasks"
              description="Retrieving the shared response checklist."
              layout="panel"
              shape="rows"
              shapeRows={3}
              className="min-h-48"
            />
          ) : (
            <>
              {tasksError ? (
                <LoadError
                  error={tasksError}
                  title={tasks === null ? 'Could not load tasks' : 'Could not refresh tasks'}
                  fallback="The shared response checklist is temporarily unavailable."
                  retryLabel="Retry tasks"
                  onRetry={onRetryTasks}
                  className={tasks !== null ? 'mb-3' : undefined}
                />
              ) : null}
              {tasks !== null ? (
                <CaseTasks
                  tasks={tasks}
                  canWrite={canWrite}
                  busyId={tasksBusyId}
                  onAdd={onAddTask}
                  onStatus={onTaskStatus}
                  onLog={onTaskLog}
                />
              ) : null}
            </>
          )}
        </PanelCard>

        <PanelCard
          data-collaboration-rail-section={isCaseManager ? 'activity' : undefined}
          className={cn(
            'p-4',
            isCaseManager &&
              'rounded-none border-x-0 border-b-0 border-t border-border/60 bg-transparent px-0 py-4 shadow-none',
          )}
        >
          <SectionHeading icon={History}>
            Activity
          </SectionHeading>
          <LoadingBar
            active={activityLoading && activity !== null}
            size="sm"
            label="Refreshing case activity"
            className="mb-3"
          />
          {activityError ? (
            <LoadError
              error={activityError}
              title={activity === null ? 'Could not load activity' : 'Could not refresh activity'}
              fallback="The authoritative case timeline is temporarily unavailable."
              retryLabel="Retry activity"
              onRetry={onRetryActivity}
              className={activity !== null ? 'mb-3' : undefined}
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
        </PanelCard>
      </aside>
    </div>
  );
};

export default CollaborationThreadTab;
