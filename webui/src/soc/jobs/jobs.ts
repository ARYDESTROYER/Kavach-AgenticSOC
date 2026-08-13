/** Shared Console helpers for durable, self-scoped background jobs. */
import { api, type BlobDownload } from '@/lib/api';
import { humanizeToken } from '@/lib/format';
import type { BackgroundJob, BackgroundJobKind } from '@/lib/types';
import type { NavOpts } from '@/soc/nav-types';
import type { PageId } from '@/soc/nav';
import {
  hasValidRouteEncoding,
  isSafeCaseId,
  isSafeCaseResultAssignee,
  isSafeCaseResultStatus,
  isSafeCaseResultTag,
  isSafeRouteToken,
} from '@/soc/case-result-route';

export const JOBS_CHANGED_EVENT = 'agentic-soc:jobs-changed';
export const JOB_ACCEPTED_EVENT = 'agentic-soc:job-accepted';

export const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
export const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

export function isActiveJobStatus(status?: string | null): boolean {
  return ACTIVE_JOB_STATUSES.has(String(status || '').toLowerCase());
}

export function isTerminalJobStatus(status?: string | null): boolean {
  return TERMINAL_JOB_STATUSES.has(String(status || '').toLowerCase());
}

/** Notify mounted Inbox/bell surfaces that their durable server projection changed. */
export function announceJobsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
}

/**
 * Register a locally accepted job before any authoritative list snapshot arrives.
 * This closes the first-snapshot race: a very fast terminal transition is new work,
 * not historical terminal history that the shell should silently suppress.
 */
export function announceJobAccepted(job: BackgroundJob): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<Pick<BackgroundJob, 'job_id' | 'status'>>(JOB_ACCEPTED_EVENT, {
      detail: { job_id: job.job_id, status: job.status },
    }),
  );
  announceJobsChanged();
}

function randomIntentId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface JobSubmissionIntent {
  kind: BackgroundJobKind;
  material: string;
  idempotencyKey: string;
}

/**
 * Keep one idempotency key while a single user intent is being submitted. Callers
 * retain the returned object across an ambiguous request failure and clear it only
 * after the server conclusively accepts the job. A later, deliberate repeat starts
 * with `current=null` and therefore receives a new key.
 */
export function retainJobSubmissionIntent(
  current: JobSubmissionIntent | null,
  kind: BackgroundJobKind,
  params: Record<string, unknown>,
): JobSubmissionIntent {
  const material = stableJson({ kind, params });
  if (current?.kind === kind && current.material === material) return current;
  const prefix = kind.replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'job';
  return {
    kind,
    material,
    idempotencyKey: `${prefix}-${randomIntentId()}`.slice(0, 120),
  };
}

/** Create a fresh key for a new intent. Prefer retainJobSubmissionIntent in UI flows. */
export function createJobIdempotencyKey(
  kind: BackgroundJobKind,
  params: Record<string, unknown>,
): string {
  return retainJobSubmissionIntent(null, kind, params).idempotencyKey;
}

export interface JobDestination {
  page: PageId;
  opts?: NavOpts;
}

const SIMPLE_DESTINATIONS: Readonly<Record<string, PageId>> = {
  cases: 'cases',
  case_manager: 'case_manager',
  inbox: 'inbox',
  knowledge: 'knowledge',
  runbooks: 'runbooks',
  batchjobs: 'batchjobs',
};

const SAFE_SETTINGS_SECTIONS = new Set(['data_export', 'danger', 'storage', 'knowledge']);

/** Backend-authored compatibility destinations mapped onto the Console router. */
const FIXED_SERVER_DESTINATIONS: Readonly<Record<string, JobDestination>> = {
  '#/settings/data-export': {
    page: 'settings',
    opts: { section: 'data_export' },
  },
  '#/settings/danger-zone': { page: 'settings', opts: { section: 'danger' } },
  '#/settings/storage': { page: 'settings', opts: { section: 'storage' } },
  '#/intelligence/knowledge': { page: 'knowledge' },
  '#/analytics?tab=jobs': { page: 'batchjobs' },
};

/**
 * Validate one backend-authored job destination before it reaches the hash router.
 * Only known same-app routes and a tiny query allowlist survive; absolute URLs,
 * script schemes, encoded route separators and unknown Settings sections fail shut.
 */
export function jobDestinationFromUrl(url?: string | null): JobDestination | null {
  const raw = String(url || '').trim();
  const fixed = FIXED_SERVER_DESTINATIONS[raw];
  if (fixed) return fixed;
  const match = /^#\/([a-z_]+)(?:\?([^#]*))?$/.exec(raw);
  if (!match) return null;
  const route = match[1];
  const rawQuery = match[2] || '';
  if (!hasValidRouteEncoding(rawQuery)) return null;
  const query = new URLSearchParams(rawQuery);

  if (route === 'settings') {
    const allowed = new Set(['s', 'section', 'a', 'anchor']);
    if (Array.from(query.keys()).some((key) => !allowed.has(key))) return null;
    if (query.has('s') && query.has('section')) return null;
    if (query.has('a') && query.has('anchor')) return null;
    if (Array.from(allowed).some((key) => query.getAll(key).length > 1)) return null;
    const section = query.get('s') || query.get('section') || '';
    const anchor = query.get('a') || query.get('anchor') || undefined;
    if (!SAFE_SETTINGS_SECTIONS.has(section)) return null;
    if (anchor && !isSafeRouteToken(anchor)) return null;
    return { page: 'settings', opts: { section, anchor } };
  }

  const page = SIMPLE_DESTINATIONS[route];
  if (!page) return null;
  const allowed =
    page === 'cases'
      ? new Set(['caseId', 'case_id', 'status', 'assignee', 'tag'])
      : page === 'case_manager'
        ? new Set(['caseId', 'case_id'])
        : new Set<string>();
  if (Array.from(query.keys()).some((key) => !allowed.has(key))) return null;
  if (query.has('caseId') && query.has('case_id')) return null;
  if (Array.from(allowed).some((key) => query.getAll(key).length > 1)) return null;
  const caseId = query.get('caseId') || query.get('case_id') || undefined;
  const status = query.get('status') || undefined;
  const assignee = query.get('assignee') || undefined;
  const tag = query.get('tag') || undefined;
  if (caseId && !isSafeCaseId(caseId)) return null;
  if (status && !isSafeCaseResultStatus(status)) return null;
  if (assignee && !isSafeCaseResultAssignee(assignee)) return null;
  if (tag && !isSafeCaseResultTag(tag)) return null;
  return {
    page,
    opts: caseId || status || assignee || tag ? { caseId, status, assignee, tag } : undefined,
  };
}

/** Stable safe destination for a backend-authored result kind; unknown kinds hide. */
export function jobDestinationForKind(kindValue?: string | null): JobDestination | null {
  const kind = String(kindValue || '').toLowerCase();
  if (kind.includes('case')) return { page: 'cases', opts: { status: 'active' } };
  if (kind.includes('export')) return { page: 'settings', opts: { section: 'data_export' } };
  if (kind.includes('runbook')) return { page: 'runbooks' };
  if (kind.includes('rag') || kind.includes('precedent') || kind.includes('knowledge')) {
    return { page: 'knowledge' };
  }
  if (kind.includes('batch')) return { page: 'batchjobs' };
  if (kind.includes('reset')) return { page: 'settings', opts: { section: 'danger' } };
  if (kind.includes('storage')) return { page: 'settings', opts: { section: 'storage' } };
  return null;
}

/** Stable safe fallback when an older server omits the additive result URL. */
export function jobDestination(job: BackgroundJob): JobDestination {
  // BackgroundJobKind is a closed current wire enum, so this normally resolves to
  // a domain surface. A future server kind falls back to the unified Jobs surface,
  // never an unrelated unfiltered list or a self-loop back to Inbox.
  return jobDestinationForKind(job.kind) ?? { page: 'batchjobs' };
}

export function jobActionLabel(
  job: BackgroundJob,
  destination: JobDestination = jobDestination(job),
): string {
  if (destination.page === 'settings' && destination.opts?.section === 'data_export') {
    return 'Open Data export';
  }
  if (destination.page === 'case_manager') return 'View case';
  if (destination.page === 'cases') return 'View matching cases';
  if (destination.page === 'knowledge') return 'Open Knowledge';
  if (destination.page === 'runbooks') return 'Open Runbooks';
  return destination.page === 'inbox' ? 'Open Inbox' : 'View result';
}

/** Truthful plain-text summary when the server did not provide a curated one. */
export function jobSummary(job: BackgroundJob): string {
  const counts = job.result?.counts ?? {};
  const total = Number.isFinite(counts.total) ? counts.total : job.progress.total;
  const succeeded = Number.isFinite(counts.succeeded)
    ? counts.succeeded
    : Math.max(0, job.progress.done - (counts.failed || 0));
  const failed = Number.isFinite(counts.failed) ? counts.failed : job.failure_count;
  const unit = job.progress.unit?.trim() || 'items';
  if (job.status === 'cancelled') {
    return `Cancelled after ${job.progress.done.toLocaleString()} of ${total.toLocaleString()} ${unit}.`;
  }
  if (job.status === 'failed' && job.progress.done === 0) {
    return `${humanizeToken(job.kind)} failed before any ${unit} completed.`;
  }
  const failurePart = failed > 0 ? ` · ${failed.toLocaleString()} failed` : '';
  return `${succeeded.toLocaleString()} of ${total.toLocaleString()} ${unit} completed${failurePart}.`;
}

function unquoteDispositionValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return trimmed;
}

function safeFilename(candidate: string): string | null {
  const basename = candidate
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim();
  if (!basename || basename.length > 180) return null;
  const safe = basename
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!safe || !/[A-Za-z0-9]/.test(safe)) return null;
  return safe;
}

export function artifactFilename(contentDisposition: string | null, fallback: string): string {
  if (contentDisposition) {
    const candidates: string[] = [];
    const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(contentDisposition)?.[1];
    if (extended) {
      const encoded = unquoteDispositionValue(extended);
      const match = /^([^']*)'[^']*'(.*)$/.exec(encoded);
      if (match && /^utf-8$/i.test(match[1])) {
        try {
          candidates.push(decodeURIComponent(match[2]));
        } catch {
          // Malformed filename* falls through to the plain/fallback name.
        }
      }
    }
    const plain = /(?:^|;)\s*filename\s*=\s*("(?:\\.|[^"])*"|[^;]*)/i.exec(contentDisposition)?.[1];
    if (plain) candidates.push(unquoteDispositionValue(plain));
    for (const candidate of candidates) {
      const safe = safeFilename(candidate);
      if (safe) return safe;
    }
  }
  return safeFilename(fallback) || 'agentic-soc-job-artifact.bin';
}

export function saveBlob(download: BlobDownload, fallbackFilename: string): string {
  if (!download.blob.size)
    throw new Error('The server returned an empty artifact. No file was saved.');
  const filename = artifactFilename(download.contentDisposition, fallbackFilename);
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const revokeObjectUrl = URL.revokeObjectURL;
  window.setTimeout(() => revokeObjectUrl(url), 0);
  return filename;
}

export async function downloadJobArtifact(job: BackgroundJob): Promise<string> {
  if (!job.result?.artifact_id)
    throw new Error('This job did not produce a downloadable artifact.');
  return downloadJobArtifactById(job.job_id, job.kind);
}

export async function downloadJobArtifactById(jobId: string, kind = 'job'): Promise<string> {
  const download = await api.jobs.artifact(jobId);
  const extension = kind.toLowerCase().includes('export') ? 'zip' : 'bin';
  return saveBlob(download, `agentic-soc-${jobId}.${extension}`);
}
