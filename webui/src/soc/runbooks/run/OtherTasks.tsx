/**
 * "Other tasks" in a case's Runbook tab (Round 14, SPEC §4.10.7, D36, E7): the case's
 * free-form tasks, under the phases, with "Added by Asha Rao at 14:29 UTC · not from the
 * runbook" provenance and "Add task". They keep their own store (`/api/cases/{id}/tasks`)
 * and never count toward runbook progress.
 *
 * A task does not store who added it; the case activity does (`task_added`, with the
 * task id), so the provenance is read from there and is left out when the activity cannot
 * be read. Titles, names and notes are plain text (#9); a task never changes the case (#3).
 */
import * as React from 'react';
import { toast } from 'sonner';

import { errorMessage } from '@/lib/errorMessage';
import { LoadingState } from '@/design-system';
import { CaseTasks } from '@/soc/components/CaseTasks';
import { LoadError } from '@/soc/components/LoadError';
import {
  addTask,
  getActivity,
  getTasks,
  logTask,
  patchTask,
  type CaseTask,
  type TaskStatus,
} from '@/soc/pages/CaseDetail.api';

import { actorName, utcTime, type NameOf } from './model';

export interface OtherTasksProps {
  caseId: string;
  tasks: CaseTask[];
  canWrite: boolean;
  nameOf?: NameOf;
  /** Read the case's runbooks (and with them the tasks) again after a change. */
  onChanged: () => Promise<void> | void;
}

/** Task id to who added it and when, from the case activity. */
export function taskAuthors(items: Array<{ kind: string; actor: string; ts: string; ref?: Record<string, unknown> }>): Map<string, { by: string; at: string }> {
  const out = new Map<string, { by: string; at: string }>();
  for (const item of items) {
    if (item.kind !== 'task_added') continue;
    const taskId = typeof item.ref?.task_id === 'string' ? item.ref.task_id : '';
    if (!taskId || out.has(taskId)) continue;
    out.set(taskId, { by: item.actor, at: item.ts });
  }
  return out;
}

export function OtherTasks({ caseId, tasks, canWrite, nameOf, onChanged }: OtherTasksProps) {
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [authors, setAuthors] = React.useState<Map<string, { by: string; at: string }>>(new Map());
  const taskKey = tasks.map((t) => t.id).join(',');

  React.useEffect(() => {
    if (!taskKey) return undefined;
    let alive = true;
    void getActivity(caseId)
      .then((res) => {
        if (alive) setAuthors(taskAuthors(res.activity || []));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [caseId, taskKey]);

  const run = async (id: string, call: () => Promise<unknown>, failure: string) => {
    setBusyId(id);
    try {
      await call();
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err, failure));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="Other tasks" data-other-tasks="">
      <CaseTasks
        variant="other"
        tasks={tasks}
        canWrite={canWrite}
        busyId={busyId}
        provenanceOf={(task) => {
          const who = authors.get(task.id);
          if (who) return `Added by ${actorName(who.by, nameOf)} at ${utcTime(who.at)} · not from the runbook`;
          return task.created_at ? `Added at ${utcTime(task.created_at)} · not from the runbook` : 'Not from the runbook';
        }}
        onAdd={(title) => void run('__add__', () => addTask(caseId, { title }), 'Could not add the task.')}
        onStatus={(taskId, status: TaskStatus) =>
          void run(taskId, () => patchTask(caseId, taskId, { status }), 'Could not update the task.')
        }
        onLog={(taskId, note) => void run(taskId, () => logTask(caseId, taskId, note), 'Could not log the note.')}
      />
    </section>
  );
}

/**
 * The same "Other tasks" for a viewer with no Runbook tab (no `runbooks:read`): it reads
 * the tasks itself (`GET /api/cases/{id}/tasks`) so they never become unreachable. Shown
 * in the Collaboration tab's rail.
 */
export function OtherTasksLoader({ caseId, canWrite, nameOf }: Omit<OtherTasksProps, 'tasks' | 'onChanged'>) {
  const [tasks, setTasks] = React.useState<CaseTask[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const load = React.useCallback(async () => {
    try {
      const res = await getTasks(caseId);
      setTasks(res.tasks || []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [caseId]);
  React.useEffect(() => {
    setTasks(null);
    setError(null);
    void load();
  }, [load]);
  if (tasks === null && error) {
    return (
      <LoadError
        error={error}
        title="Could not load tasks"
        fallback="The case tasks are temporarily unavailable."
        retryLabel="Retry tasks"
        onRetry={() => void load()}
      />
    );
  }
  if (tasks === null) {
    return <LoadingState label="Loading case tasks" layout="panel" shape="rows" shapeRows={3} className="min-h-32" />;
  }
  return <OtherTasks caseId={caseId} tasks={tasks} canWrite={canWrite} nameOf={nameOf} onChanged={load} />;
}
