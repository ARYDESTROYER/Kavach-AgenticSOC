/** Global durable-job observer: SSE nudge + polling fallback + terminal toasts. */
import * as React from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { humanizeToken } from '@/lib/format';
import type { BackgroundJob } from '@/lib/types';
import { useEventStream } from '@/lib/useEventStream';
import type { Navigate } from '@/soc/router';
import {
  announceJobsChanged,
  downloadJobArtifact,
  isTerminalJobStatus,
  JOB_ACCEPTED_EVENT,
  jobActionLabel,
  jobDestination,
  jobDestinationFromUrl,
  jobSummary,
} from './jobs';

const POLL_MS = 10_000;
const POLL_MS_LIVE = 60_000;
const LIST_LIMIT = 100;
const SEEN_LIMIT = 200;
const PENDING_LIMIT = 100;

function seenStorageKey(actor?: string | null): string {
  return `agentic-soc.jobs.terminal-toasts:${String(actor || 'default')
    .trim()
    .toLowerCase()}`;
}

function pendingStorageKey(actor?: string | null): string {
  return `agentic-soc.jobs.locally-accepted:${String(actor || 'default')
    .trim()
    .toLowerCase()}`;
}

function loadPending(actor?: string | null): Set<string> {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(pendingStorageKey(actor)) || '[]');
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistPending(actor: string | null | undefined, ids: Set<string>): void {
  try {
    window.sessionStorage.setItem(
      pendingStorageKey(actor),
      JSON.stringify(Array.from(ids).slice(-PENDING_LIMIT)),
    );
  } catch {
    /* First-snapshot protection is best-effort when browser storage is unavailable. */
  }
}

function loadSeen(actor?: string | null): Set<string> {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(seenStorageKey(actor)) || '[]');
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

function persistSeen(actor: string | null | undefined, ids: Set<string>): void {
  try {
    const bounded = Array.from(ids).slice(-SEEN_LIMIT);
    window.sessionStorage.setItem(seenStorageKey(actor), JSON.stringify(bounded));
  } catch {
    /* Toast dedupe is best-effort when browser storage is unavailable. */
  }
}

export function terminalJobTitle(job: BackgroundJob): string {
  const label = humanizeToken(job.kind);
  if (job.status === 'succeeded') return `${label} completed`;
  if (job.status === 'partial') return `${label} completed with failures`;
  if (job.status === 'cancelled') return `${label} cancelled`;
  return `${label} failed`;
}

export function JobMonitor({ actor, onNavigate }: { actor?: string | null; onNavigate: Navigate }) {
  const mountedRef = React.useRef(true);
  const initializedRef = React.useRef(false);
  const requestRef = React.useRef(0);
  const controllerRef = React.useRef<AbortController | null>(null);
  const statusRef = React.useRef(new Map<string, string>());
  const locallyAcceptedRef = React.useRef(loadPending(actor));
  const seenRef = React.useRef(loadSeen(actor));

  React.useEffect(() => {
    seenRef.current = loadSeen(actor);
    initializedRef.current = false;
    statusRef.current = new Map();
    locallyAcceptedRef.current = loadPending(actor);
  }, [actor]);

  const showTerminalToast = React.useCallback(
    async (job: BackgroundJob) => {
      if (seenRef.current.has(job.job_id)) return;
      seenRef.current.add(job.job_id);
      persistSeen(actor, seenRef.current);

      // The Inbox notification is the server-owned durable projection and carries
      // the curated destination. Resolve it through a strict same-app allowlist;
      // a missing/older notification falls back to a kind-derived safe surface.
      let destination = jobDestination(job);
      try {
        const response = await api.get<{
          items?: Array<{ job_id?: string | null; url?: string | null }>;
        }>('notifications/inbox', { limit: LIST_LIMIT, offset: 0 });
        const notification = response.items?.find((item) => item.job_id === job.job_id);
        destination = jobDestinationFromUrl(notification?.url) ?? destination;
      } catch {
        // The terminal toast remains useful if the durable Inbox is temporarily
        // unavailable; the Inbox itself will be retried independently.
      }
      if (!mountedRef.current) return;

      const options = {
        description: jobSummary(job),
        duration: 9_000,
        action: {
          label: jobActionLabel(job, destination),
          onClick: () => onNavigate(destination.page, destination.opts),
        },
        ...(job.result?.artifact_id
          ? {
              cancel: {
                label: 'Download',
                onClick: () => {
                  void downloadJobArtifact(job)
                    .then((filename) => toast.success(`Downloaded ${filename}.`))
                    .catch((error) =>
                      toast.error(errorMessage(error, 'Could not download the job artifact.')),
                    );
                },
              },
            }
          : {}),
      };
      const title = terminalJobTitle(job);
      if (job.status === 'succeeded') toast.success(title, options);
      else if (job.status === 'failed') toast.error(title, options);
      else if (job.status === 'cancelled') toast.info(title, options);
      else toast.warning(title, options);
    },
    [actor, onNavigate],
  );

  const refresh = React.useCallback(async () => {
    const requestId = (requestRef.current += 1);
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await api.jobs.list({ limit: LIST_LIMIT, offset: 0 }, controller.signal);
      if (!mountedRef.current || controller.signal.aborted || requestId !== requestRef.current)
        return;
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      const previous = statusRef.current;
      const firstSnapshot = !initializedRef.current;

      for (const job of jobs) {
        if (!isTerminalJobStatus(job.status)) continue;
        const locallyAccepted = locallyAcceptedRef.current.has(job.job_id);
        if (firstSnapshot && !locallyAccepted) {
          // Existing terminal history belongs in the durable Inbox; mounting the
          // Console must not replay a wall of stale transient toasts.
          seenRef.current.add(job.job_id);
          continue;
        }
        const prior = previous.get(job.job_id) ?? (locallyAccepted ? 'queued' : undefined);
        if (!isTerminalJobStatus(prior)) void showTerminalToast(job);
        locallyAcceptedRef.current.delete(job.job_id);
        persistPending(actor, locallyAcceptedRef.current);
      }
      if (firstSnapshot) persistSeen(actor, seenRef.current);
      statusRef.current = new Map(jobs.map((job) => [job.job_id, job.status]));
      initializedRef.current = true;
      announceJobsChanged();
    } catch {
      // Quiet by design. The Inbox owns the durable, actionable load error; this
      // shell observer simply keeps polling when SSE or the backend is unavailable.
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [actor, showTerminalToast]);

  React.useEffect(() => {
    const onAccepted = (event: Event) => {
      const detail = (event as CustomEvent<{ job_id?: unknown }>).detail;
      const jobId = typeof detail?.job_id === 'string' ? detail.job_id.trim() : '';
      if (!jobId) return;
      locallyAcceptedRef.current.add(jobId);
      persistPending(actor, locallyAcceptedRef.current);
      // Always seed queued: even an unusually fast 202 response/list transition to
      // terminal must be observed as a new local operation, never old history.
      statusRef.current.set(jobId, 'queued');
      void refresh();
    };
    window.addEventListener(JOB_ACCEPTED_EVENT, onAccepted);
    return () => window.removeEventListener(JOB_ACCEPTED_EVENT, onAccepted);
  }, [actor, refresh]);

  const onEvent = React.useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    void refresh();
  }, [refresh]);
  const { live } = useEventStream(['jobs'], { enabled: true, onEvent });

  React.useEffect(() => {
    mountedRef.current = true;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void refresh();
    };
    tick();
    const interval = window.setInterval(tick, live ? POLL_MS_LIVE : POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      controllerRef.current?.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [live, refresh]);

  return null;
}

export default JobMonitor;
