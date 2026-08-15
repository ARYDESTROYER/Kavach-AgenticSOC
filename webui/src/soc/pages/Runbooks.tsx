/**
 * Intelligence / Runbooks — trusted RAG reference knowledge.
 *
 * Runbooks answer "what should an analyst know while investigating this signal?".
 * They are deliberately separate from Playbooks, which are selected procedures.
 * Saving a runbook and indexing it are also separate outcomes: the UI preserves a
 * successful durable write even when the RAG projection needs attention.
 *
 * All Markdown and metadata are operator/backend-derived and therefore rendered as
 * plain text or inside CodeBlock. Nothing is interpreted as HTML.
 */
import * as React from 'react';
import {
  AlertCircle,
  BookMarked,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import type {
  Runbook,
  RunbookAuthoringStandard as RunbookAuthoringStandardContract,
  RunbookDetail,
  RunbookIndexResult,
} from '@/lib/types';
import { LoadingState } from '@/design-system';
import { useCan } from '@/soc/components/Can';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageHeader } from '@/soc/components/PageHeader';
import { useLiveAnnouncer } from '@/soc/hooks/useLiveAnnouncer';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import { useNavigateOptional } from '@/soc/router';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge, type BadgeProps } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/ui/sheet';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

import {
  extractRunbookBackendIssues,
  RUNBOOK_BODY_MAX_CHARS,
  RUNBOOK_DESCRIPTOR_MAX_CHARS,
  RUNBOOK_LIST_ITEM_MAX_CHARS,
  RUNBOOK_LIST_MAX_ITEMS,
  RUNBOOK_OPTIONAL_SECTION,
  RUNBOOK_PERSONA_MAX_CHARS,
  RUNBOOK_REQUIRED_SECTIONS,
  RUNBOOK_SUMMARY_MAX_CHARS,
  RUNBOOK_TITLE_MAX_CHARS,
  runbookTemplate,
  type RunbookAuthoringIssue,
  validateRunbookAuthoring,
} from './runbookAuthoring';
import { RUNBOOK_EXAMPLES, type RunbookExample } from './runbookExamples';

type RunbookFilter = 'all' | 'operator' | 'bundled' | 'attention';
type WorkspaceMode = 'view' | 'edit' | 'create';

const RUNBOOK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CURRENT_INDEX_STATES = new Set(['indexed', 'ready', 'current', 'in_sync']);

function authoringPolicyMismatch(
  standard: RunbookAuthoringStandardContract | undefined,
): RunbookAuthoringIssue | null {
  if (!standard) return null;
  const limits = standard.metadata_limits;
  const labelsMatch =
    JSON.stringify(standard.required_body_labels) === JSON.stringify(RUNBOOK_REQUIRED_SECTIONS) &&
    JSON.stringify(standard.optional_body_labels) === JSON.stringify([RUNBOOK_OPTIONAL_SECTION]);
  const compatible =
    standard.version === 1 &&
    standard.body_max_characters === RUNBOOK_BODY_MAX_CHARS &&
    standard.retrieval_descriptor_max_characters === RUNBOOK_DESCRIPTOR_MAX_CHARS &&
    standard.document_max_bytes === 128 * 1024 &&
    standard.section_min_characters === 12 &&
    JSON.stringify(standard.reserved_ids) === JSON.stringify(['index', 'readme', 'reindex']) &&
    limits.title_max_characters === RUNBOOK_TITLE_MAX_CHARS &&
    limits.summary_max_characters === RUNBOOK_SUMMARY_MAX_CHARS &&
    limits.persona_max_characters === RUNBOOK_PERSONA_MAX_CHARS &&
    limits.list_max_items === RUNBOOK_LIST_MAX_ITEMS &&
    limits.list_item_max_characters === RUNBOOK_LIST_ITEM_MAX_CHARS &&
    labelsMatch;
  if (compatible) return null;
  return {
    code: 'authoring.standard.mismatch',
    field: 'authoring policy',
    problem: 'This Console does not match the backend Runbook authoring standard.',
    reason: 'Saving with a stale validator could hide a server-side rejection or accept outdated guidance.',
    fix: 'Reload after updating the Console to the same release as the backend. Saving is blocked until they match.',
  };
}

function replaceFrontmatterId(content: string, id: string): string {
  if (/^---\s*\n[\s\S]*?\n---/.test(content)) {
    if (/^id:\s*.*$/m.test(content)) return content.replace(/^id:\s*.*$/m, `id: ${id}`);
    return content.replace(/^---\s*\n/, `---\nid: ${id}\n`);
  }
  return content;
}

function revisionEqual(left: Runbook['revision'], right: Runbook['indexed_revision']): boolean {
  return right != null && String(left) === String(right);
}

function isIndexed(runbook: Runbook): boolean {
  return (
    CURRENT_INDEX_STATES.has(String(runbook.index_status || '').toLowerCase()) &&
    revisionEqual(runbook.revision, runbook.indexed_revision) &&
    !runbook.index_error
  );
}

function needsIndexAttention(runbook: Runbook): boolean {
  return !isIndexed(runbook);
}

function indexLabel(runbook: Runbook): string {
  if (runbook.index_error) return 'Index error';
  if (
    CURRENT_INDEX_STATES.has(String(runbook.index_status || '').toLowerCase()) &&
    !revisionEqual(runbook.revision, runbook.indexed_revision)
  ) {
    return 'Update pending';
  }
  return humanizeToken(runbook.index_status || 'Not indexed');
}

function indexVariant(runbook: Runbook): BadgeProps['variant'] {
  if (isIndexed(runbook)) return 'success';
  if (runbook.index_error || String(runbook.index_status).toLowerCase() === 'error') {
    return 'critical';
  }
  return 'warning';
}

function describeIndex(result: RunbookIndexResult): string {
  const parts = [
    `${result.indexed} indexed`,
    `${result.deleted} stale ${result.deleted === 1 ? 'projection' : 'projections'} removed`,
    `${result.failed} failed`,
  ];
  return parts.join(' · ');
}

function indexErrors(result: RunbookIndexResult): string[] {
  return (result.errors ?? []).map((entry) =>
    typeof entry === 'string'
      ? entry
      : `${entry.id ? `${entry.id}: ` : ''}${entry.error}`,
  );
}

function upsertRunbook(rows: Runbook[], next: Runbook): Runbook[] {
  return [...rows.filter((row) => row.id !== next.id), next].sort((a, b) =>
    (a.title || a.id).localeCompare(b.title || b.id),
  );
}

const TokenRow: React.FC<{
  label: string;
  values: string[];
  variant?: BadgeProps['variant'];
}> = ({ label, values, variant = 'outline' }) => (
  <div className="space-y-2">
    <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
      {label}
    </p>
    {values.length ? (
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant={variant} className="max-w-full">
            <span className="truncate">{value}</span>
          </Badge>
        ))}
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">Any</p>
    )}
  </div>
);

const IndexBadge: React.FC<{ runbook: Runbook }> = ({ runbook }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Badge variant={indexVariant(runbook)} tabIndex={0} className="cursor-default gap-1">
        {isIndexed(runbook) ? (
          <CheckCircle2 className="size-3" aria-hidden="true" />
        ) : (
          <AlertCircle className="size-3" aria-hidden="true" />
        )}
        {indexLabel(runbook)}
      </Badge>
    </TooltipTrigger>
    <TooltipContent className="max-w-sm">
      {runbook.index_error
        ? runbook.index_error
        : isIndexed(runbook)
          ? `Retrieval projection matches revision ${String(runbook.revision)}.`
          : 'The durable Markdown is saved, but its retrieval projection is not current.'}
    </TooltipContent>
  </Tooltip>
);

const RunbookReadiness: React.FC<{
  issues: RunbookAuthoringIssue[];
  bodyCharacters: number;
  descriptorCharacters: number;
}> = ({ issues, bodyCharacters, descriptorCharacters }) => {
  const overBy = Math.max(0, bodyCharacters - RUNBOOK_BODY_MAX_CHARS);
  const descriptorOverBy = Math.max(
    0,
    descriptorCharacters - RUNBOOK_DESCRIPTOR_MAX_CHARS,
  );
  return (
    <section
      aria-labelledby="runbook-readiness-title"
      className="space-y-3 border border-border bg-muted/20 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="runbook-readiness-title" className="text-sm font-semibold text-foreground">
            Submission readiness
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            All issues are checked locally as you type. The backend verifies the same policy.
          </p>
        </div>
        <Badge variant={issues.length ? 'critical' : 'success'}>
          {issues.length ? `${issues.length} ${issues.length === 1 ? 'fix' : 'fixes'}` : 'Ready'}
        </Badge>
      </div>

      <div
        className="space-y-1"
        aria-live="polite"
        aria-atomic="true"
        data-testid="runbook-body-budget"
      >
        <div className="flex items-center justify-between gap-3 font-mono text-xs">
          <span className="text-muted-foreground">Guidance body</span>
          <span className={overBy ? 'font-semibold text-critical-text' : 'text-foreground'}>
            {bodyCharacters.toLocaleString()} / {RUNBOOK_BODY_MAX_CHARS.toLocaleString()}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden bg-muted" aria-hidden="true">
          <div
            className={overBy ? 'h-full bg-critical' : 'h-full bg-primary'}
            style={{
              width: `${Math.min(100, (bodyCharacters / RUNBOOK_BODY_MAX_CHARS) * 100)}%`,
            }}
          />
        </div>
        <p className={overBy ? 'text-xs text-critical-text' : 'text-xs text-muted-foreground'}>
          {overBy
            ? `Remove ${overBy.toLocaleString()} characters before submitting.`
            : 'Maximum 1,800 body characters, approximately 400–500 tokens. Front matter does not count.'}
        </p>
      </div>

      <div className="space-y-1" data-testid="runbook-descriptor-budget">
        <div className="flex items-center justify-between gap-3 font-mono text-xs">
          <span className="text-muted-foreground">Retrieval metadata</span>
          <span
            className={
              descriptorOverBy ? 'font-semibold text-critical-text' : 'text-foreground'
            }
          >
            {descriptorCharacters.toLocaleString()} /{' '}
            {RUNBOOK_DESCRIPTOR_MAX_CHARS.toLocaleString()}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden bg-muted" aria-hidden="true">
          <div
            className={descriptorOverBy ? 'h-full bg-critical' : 'h-full bg-primary'}
            style={{
              width: `${Math.min(
                100,
                (descriptorCharacters / RUNBOOK_DESCRIPTOR_MAX_CHARS) * 100,
              )}%`,
            }}
          />
        </div>
        <p
          className={
            descriptorOverBy ? 'text-xs text-critical-text' : 'text-xs text-muted-foreground'
          }
        >
          {descriptorOverBy
            ? `Remove ${descriptorOverBy.toLocaleString()} descriptor characters before submitting.`
            : 'Maximum 1,200 characters across the retrieval descriptor; guidance body is counted separately.'}
        </p>
      </div>

      {issues.length ? (
        <ol
          className="max-h-[22rem] space-y-2 overflow-y-auto border-t border-border pt-3"
          aria-label="Runbook submission issues"
        >
          {issues.map((issue, index) => (
            <li
              key={`${issue.code}:${issue.field}:${index}`}
              className="border-l-2 border-critical/70 pl-3"
            >
              <p className="text-xs font-semibold text-foreground">
                <span className="text-critical-text">{issue.field}:</span> {issue.problem}
              </p>
              <dl className="mt-1 grid gap-x-2 gap-y-1 text-xs leading-relaxed text-muted-foreground sm:grid-cols-[2.5rem_minmax(0,1fr)]">
                <dt className="font-medium text-foreground">Why</dt>
                <dd>{issue.reason}</dd>
                <dt className="font-medium text-foreground">Fix</dt>
                <dd>{issue.fix}</dd>
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex items-start gap-2 border-t border-border pt-3 text-xs leading-relaxed text-success-text">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>The manifest, fixed sections, plain-text format, and token budget are valid.</p>
        </div>
      )}
    </section>
  );
};

const RunbookAuthoringStandard: React.FC<{
  contract?: RunbookAuthoringStandardContract;
}> = ({ contract }) => (
  <aside aria-labelledby="runbook-standard-title" className="space-y-4 lg:sticky lg:top-0">
    <div className="border border-border bg-muted/10 p-4">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h3 id="runbook-standard-title" className="text-sm font-semibold text-foreground">
            Authoring standard
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Compact, reviewed guidance gives smaller models more room for live case evidence.
            The 1,800-character body budget is approximately 400–500 tokens, preserving
            evidence and verdict boundaries inside one retrieval unit.
          </p>
        </div>
      </div>
    </div>

    <details open className="group border-b border-border pb-4">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-foreground marker:text-muted-foreground">
        Required manifest
      </summary>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          Provide a stable <span className="font-mono text-foreground">id</span>, a precise{' '}
          <span className="font-mono text-foreground">title</span>, and a one-sentence{' '}
          <span className="font-mono text-foreground">summary</span>.
        </p>
        <p>
          Include at least one detection rule, entity type, and retrieval keyword. Persona and
          MITRE techniques are optional. Use applicability metadata instead of repeating it in
          the body.
        </p>
        <p>
          IDs use 1–64 lowercase letters, numbers, hyphens, or underscores and cannot be{' '}
          {(contract?.reserved_ids ?? ['index', 'readme', 'reindex']).join(', ')}. Title,
          summary, and persona are single scalar values;
          applicability fields are inline or indented lists. Unknown, duplicate, malformed,
          empty, or placeholder fields are rejected.
        </p>
        <p>
          Limits: title {RUNBOOK_TITLE_MAX_CHARS}, summary {RUNBOOK_SUMMARY_MAX_CHARS}, and
          persona {RUNBOOK_PERSONA_MAX_CHARS} characters. Each applicability list accepts at
          most {RUNBOOK_LIST_MAX_ITEMS} values of {RUNBOOK_LIST_ITEM_MAX_CHARS} characters each.
        </p>
        <p>
          The title, summary, keywords, rules, MITRE techniques, and entities form one retrieval
          descriptor capped at {RUNBOOK_DESCRIPTOR_MAX_CHARS.toLocaleString()} characters.
          Keep only selectors that materially improve matching.
        </p>
        <p>
          Optional MITRE values use T1234 or T1234.001. The complete UTF-8 document has a{' '}
          {Math.round((contract?.document_max_bytes ?? 128 * 1024) / 1024)} KiB safety ceiling.
        </p>
      </div>
    </details>

    <details open className="group border-b border-border pb-4">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-foreground marker:text-muted-foreground">
        Fixed section order
      </summary>
      <ol className="mt-3 space-y-1.5 text-xs text-muted-foreground">
        {RUNBOOK_REQUIRED_SECTIONS.map((label, index) => (
          <li key={label} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
            <span className="font-mono text-foreground">{index + 1}.</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Every required section needs at least {contract?.section_min_characters ?? 12} specific
        non-whitespace characters. Add{' '}
        {RUNBOOK_OPTIONAL_SECTION} only as the final, non-empty section. Text before SIGNAL,
        unknown or duplicate labels, and numbered lines outside INVESTIGATION STEPS are rejected.
      </p>
    </details>

    <details open className="group border-b border-border pb-4">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-foreground marker:text-muted-foreground">
        Plain text only
      </summary>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          Use one concise sentence per line. Only INVESTIGATION STEPS may use sequential,
          one-line numbering such as 1., 2., 3.
        </p>
        <p>
          Rejected: headings, tables, bullets, task lists, bold, italics, underline,
          strikethrough, horizontal rules, blockquotes, inline or block code, raw HTML, and
          Markdown links or images.
        </p>
        <p>
          These rules apply to both the manifest values and body. Ordinary field_name
          underscores and an unformatted plain URL are accepted. All other content is plain
          text; {contract?.character_count ?? 'body limits count Unicode characters after trimming'}.
        </p>
        {contract ? (
          <p>
            Backend policy: {contract.investigation_steps} Prohibited metadata and body forms:{' '}
            {[...contract.prohibited_metadata_format, ...contract.prohibited_body_format]
              .filter((value, index, values) => values.indexOf(value) === index)
              .join('; ')}.
          </p>
        ) : null}
      </div>
    </details>

    <details open className="group">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-foreground marker:text-muted-foreground">
        Evidence and authority
      </summary>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          State observations, falsifying evidence, missing-evidence behavior, and advisory next
          actions explicitly. Remove repetition, decorative prose, raw logs, and oversized
          examples.
        </p>
        <p>
          Never include secrets, credentials, customer data, or unreviewed instructions copied
          from alerts. Runbooks inform investigations; they cannot execute actions or override
          deterministic case policy.
        </p>
      </div>
    </details>
  </aside>
);

interface ExamplePreviewState {
  id: string;
  status: 'loading' | 'ready' | 'error';
  content: string;
  error: string;
}

const RunbookExamples: React.FC = () => {
  const [preview, setPreview] = React.useState<ExamplePreviewState | null>(null);
  const requestVersion = React.useRef(0);

  React.useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [],
  );

  const togglePreview = React.useCallback(async (example: RunbookExample) => {
    if (preview?.id === example.id) {
      requestVersion.current += 1;
      setPreview(null);
      return;
    }

    const request = requestVersion.current + 1;
    requestVersion.current = request;
    setPreview({ id: example.id, status: 'loading', content: '', error: '' });
    try {
      const response = await fetch(example.href, {
        cache: 'no-cache',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`Example returned HTTP ${response.status}.`);
      const content = await response.text();
      if (requestVersion.current !== request) return;
      setPreview({ id: example.id, status: 'ready', content, error: '' });
    } catch {
      if (requestVersion.current !== request) return;
      setPreview({
        id: example.id,
        status: 'error',
        content: '',
        error: 'The preview could not be loaded. Try the direct download or reload this page.',
      });
    }
  }, [preview?.id]);

  const selected = preview
    ? RUNBOOK_EXAMPLES.find((example) => example.id === preview.id)
    : undefined;

  return (
    <section aria-labelledby="runbook-examples-title" className="border-y border-border py-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div>
          <h3 id="runbook-examples-title" className="text-sm font-semibold text-foreground">
            Start from an example
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Download a reviewed reference, then adapt it locally. Previewing or downloading never
            imports, saves, indexes, or executes the Runbook. Examples are starting points, not
            coverage guarantees or automation.
          </p>
        </div>
        <p className="shrink-0 font-mono text-2xs uppercase tracking-wider text-muted-foreground">
          {RUNBOOK_EXAMPLES.length} examples · .md
        </p>
      </div>

      <div className="mt-4 grid gap-2">
        {RUNBOOK_EXAMPLES.map((example) => {
          const expanded = preview?.id === example.id;
          return (
            <article
              key={example.id}
              className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-2 border border-border p-3"
            >
              <span className="inline-flex size-8 items-center justify-center border border-border bg-muted/30 text-primary">
                <FileText className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-foreground">{example.title}</h4>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {example.description}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {example.coverage.map((label) => (
                    <Badge key={label} variant="outline" className="text-2xs">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="col-start-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded}
                  aria-controls="runbook-example-preview"
                  onClick={() => void togglePreview(example)}
                >
                  {expanded && preview?.status === 'loading' ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                  {expanded ? 'Hide preview' : 'Preview'}
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={example.href}
                    download={example.filename}
                    type="text/markdown"
                    aria-label={`Download ${example.title} example`}
                  >
                    <Download className="size-4" aria-hidden="true" />
                    Download
                  </a>
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      {preview ? (
        <div
          id="runbook-example-preview"
          className="mt-4 border-l-2 border-primary/70 bg-muted/20 p-4"
          aria-live="polite"
          aria-busy={preview.status === 'loading'}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              {selected?.title ?? 'Example'} preview
            </h4>
            <span className="font-mono text-2xs text-muted-foreground">
              {selected?.filename}
            </span>
          </div>
          {preview.status === 'loading' ? (
            <p className="mt-3 text-xs text-muted-foreground">Loading the reviewed example…</p>
          ) : preview.status === 'error' ? (
            <p role="alert" className="mt-3 text-xs text-critical-text">
              {preview.error}
            </p>
          ) : (
            <div className="mt-3">
              <CodeBlock
                value={preview.content}
                copyable
                wrap
                maxHeightClassName="max-h-96"
              />
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
};

interface RunbookRowProps {
  runbook: Runbook;
  canManage: boolean;
  reindexing: boolean;
  onOpen: (runbook: Runbook) => void;
  onReindex: (runbook: Runbook) => void;
}

const RunbookRow: React.FC<RunbookRowProps> = ({
  runbook,
  canManage,
  reindexing,
  onOpen,
  onReindex,
}) => (
  <article className="grid gap-4 border-b border-border px-1 py-5 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,0.45fr)_auto] lg:items-center">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(runbook)}
          className="min-w-0 text-left text-base font-semibold text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="break-words">{runbook.title || runbook.id}</span>
        </button>
        <Badge variant={runbook.protected ? 'secondary' : 'info'} className="gap-1">
          {runbook.protected ? (
            <LockKeyhole className="size-3" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-3" aria-hidden="true" />
          )}
          {runbook.protected ? 'Bundled' : 'Operator'}
        </Badge>
        <IndexBadge runbook={runbook} />
      </div>
      <p className="mt-1 font-mono text-xs text-muted-foreground">{runbook.id}</p>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {runbook.summary || 'No summary supplied.'}
      </p>
    </div>

    <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span>Persona</span>
      <span className="truncate text-right text-foreground">
        {humanizeToken(runbook.persona || 'generalist')}
      </span>
      <span>Applicability</span>
      <span className="text-right text-foreground">
        {runbook.applies_to_rules.length +
          runbook.applies_to_techniques.length +
          runbook.applies_to_entities.length || 'Any'}
      </span>
      <span>Updated</span>
      <span
        className="text-right text-foreground"
        title={formatTimestamp(runbook.updated_at || runbook.created_at)}
      >
        {humanizeAge(runbook.updated_at || runbook.created_at)}
      </span>
    </div>

    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
      {canManage ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReindex(runbook)}
          disabled={reindexing}
          aria-label={`Reindex ${runbook.title || runbook.id}`}
        >
          <RefreshCw
            className={reindexing ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'}
            aria-hidden="true"
          />
          Reindex
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={() => onOpen(runbook)}>
        <FileText className="size-4" aria-hidden="true" />
        Open
      </Button>
    </div>
  </article>
);

interface RunbookWorkspaceProps {
  open: boolean;
  mode: WorkspaceMode;
  detail: RunbookDetail | null;
  loading: boolean;
  saving: boolean;
  reindexing: boolean;
  draftId: string;
  draftContent: string;
  validationIssues: RunbookAuthoringIssue[];
  bodyCharacters: number;
  descriptorCharacters: number;
  error: string;
  canManage: boolean;
  authoringStandard?: RunbookAuthoringStandardContract;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: WorkspaceMode) => void;
  onDraftIdChange: (id: string) => void;
  onDraftContentChange: (content: string) => void;
  onSave: () => void;
  onReindex: () => void;
  onDelete: () => void;
}

const RunbookWorkspace: React.FC<RunbookWorkspaceProps> = ({
  open,
  mode,
  detail,
  loading,
  saving,
  reindexing,
  draftId,
  draftContent,
  validationIssues,
  bodyCharacters,
  descriptorCharacters,
  error,
  canManage,
  authoringStandard,
  onOpenChange,
  onModeChange,
  onDraftIdChange,
  onDraftContentChange,
  onSave,
  onReindex,
  onDelete,
}) => {
  const creating = mode === 'create';
  const editing = creating || mode === 'edit';
  const validId = RUNBOOK_ID.test(draftId.trim());

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="xl" className="gap-0">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>
              {creating ? 'Create runbook' : detail?.title || detail?.id || 'Runbook'}
            </SheetTitle>
            {detail ? (
              <>
                <Badge variant={detail.protected ? 'secondary' : 'info'}>
                  {detail.protected ? 'Bundled · protected' : 'Operator owned'}
                </Badge>
                <IndexBadge runbook={detail} />
              </>
            ) : null}
          </div>
          <SheetDescription>
            {creating
              ? 'Add a bounded manifest and plain-text reference for investigation retrieval.'
              : editing
                ? 'Edit the operator-owned reference. The id is immutable after creation.'
                : 'Reference knowledge retrieved through RAG. This is not an executable playbook.'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {loading ? (
            <LoadingState
              layout="panel"
              shape="panel"
              label="Loading runbook"
              description="Opening the selected reference document."
            />
          ) : editing ? (
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="min-w-0 space-y-5">
                {creating ? <RunbookExamples /> : null}
                {creating ? (
                  <div className="max-w-lg space-y-2">
                    <Label htmlFor="runbook-id">Runbook ID</Label>
                    <Input
                      id="runbook-id"
                      value={draftId}
                      onChange={(event) => onDraftIdChange(event.target.value)}
                      placeholder="suspicious_powershell"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={!validId}
                      aria-describedby="runbook-id-help"
                      className="font-mono"
                    />
                    <p
                      id="runbook-id-help"
                      className={
                        draftId && !validId
                          ? 'text-xs text-critical-text'
                          : 'text-xs text-muted-foreground'
                      }
                    >
                      Lowercase letters, numbers, underscores, or hyphens; up to 64 characters.
                    </p>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="runbook-markdown">Runbook document</Label>
                    <span
                      className={
                        bodyCharacters > RUNBOOK_BODY_MAX_CHARS
                          ? 'font-mono text-xs font-semibold text-critical-text'
                          : 'font-mono text-xs text-muted-foreground'
                      }
                    >
                      {bodyCharacters.toLocaleString()} / {RUNBOOK_BODY_MAX_CHARS.toLocaleString()}{' '}
                      body characters
                    </span>
                  </div>
                  <Textarea
                    id="runbook-markdown"
                    value={draftContent}
                    onChange={(event) => onDraftContentChange(event.target.value)}
                    className="min-h-[38rem] resize-y font-mono text-xs leading-relaxed"
                    spellCheck={false}
                    aria-invalid={validationIssues.length > 0}
                    aria-describedby="runbook-document-help runbook-readiness-title"
                  />
                  <p
                    id="runbook-document-help"
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Front matter controls precise applicability. The body accepts only the fixed
                    plain-text section template and becomes trusted knowledge after indexing.
                  </p>
                </div>
                {error ? (
                  <p role="alert" className="text-sm text-critical-text">
                    {error}
                  </p>
                ) : null}
              </div>

              <div className="min-w-0 space-y-5">
                <RunbookReadiness
                  issues={validationIssues}
                  bodyCharacters={bodyCharacters}
                  descriptorCharacters={descriptorCharacters}
                />
                <RunbookAuthoringStandard contract={authoringStandard} />
              </div>
            </div>
          ) : detail ? (
            <div className="space-y-6">
              <div className="grid gap-5 border-y border-border py-5 sm:grid-cols-2">
                <TokenRow
                  label="Detection rules"
                  values={detail.applies_to_rules}
                  variant="info"
                />
                <TokenRow
                  label="MITRE techniques"
                  values={detail.applies_to_techniques}
                  variant="critical"
                />
                <TokenRow label="Entity types" values={detail.applies_to_entities} />
                <TokenRow label="Retrieval keywords" values={detail.keywords} />
              </div>

              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Persona</dt>
                <dd className="text-foreground">{humanizeToken(detail.persona)}</dd>
                <dt className="text-muted-foreground">Revision</dt>
                <dd className="font-mono text-foreground">{String(detail.revision)}</dd>
                <dt className="text-muted-foreground">Indexed revision</dt>
                <dd className="font-mono text-foreground">
                  {detail.indexed_revision == null ? 'Not indexed' : String(detail.indexed_revision)}
                </dd>
                <dt className="text-muted-foreground">Last indexed</dt>
                <dd className="text-foreground">{formatTimestamp(detail.last_indexed_at)}</dd>
                {detail.index_error ? (
                  <>
                    <dt className="text-critical-text">Index error</dt>
                    <dd className="break-words text-critical-text">{detail.index_error}</dd>
                  </>
                ) : null}
              </dl>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Document source
                  </p>
                  <span className="font-mono text-xs text-muted-foreground">{detail.id}</span>
                </div>
                <CodeBlock value={detail.content} copyable wrap maxHeightClassName="max-h-none" />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-critical-text">
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <p role="alert" className="text-sm text-critical-text">
              {error || 'This runbook could not be opened.'}
            </p>
          )}
        </div>

        <SheetFooter className="sm:items-center sm:justify-between">
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            Runbooks are retrieval knowledge. They cannot execute actions or replace deterministic
            case policy.
          </p>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {!editing && detail && canManage ? (
              <>
                <Button
                  variant="outline"
                  onClick={onReindex}
                  disabled={reindexing}
                >
                  <RefreshCw
                    className={
                      reindexing
                        ? 'size-4 animate-spin motion-reduce:animate-none'
                        : 'size-4'
                    }
                    aria-hidden="true"
                  />
                  {reindexing ? 'Reindexing…' : 'Reindex'}
                </Button>
                {detail.editable ? (
                  <Button variant="outline" onClick={() => onModeChange('edit')}>
                    <Pencil className="size-4" aria-hidden="true" />
                    Edit
                  </Button>
                ) : null}
                {detail.editable ? (
                  <Button variant="destructive" onClick={onDelete}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </Button>
                ) : null}
              </>
            ) : null}
            {editing ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => (creating ? onOpenChange(false) : onModeChange('view'))}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button
                  onClick={onSave}
                  disabled={saving || validationIssues.length > 0 || (creating && !validId)}
                >
                  {saving ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Save className="size-4" aria-hidden="true" />
                  )}
                  {saving ? 'Saving…' : creating ? 'Create runbook' : 'Save changes'}
                </Button>
              </>
            ) : null}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

export interface RunbooksProps {
  embedded?: boolean;
}

export default function Runbooks({ embedded = false }: RunbooksProps = {}) {
  const canManage = useCan('runbooks', 'manage');
  const navigate = useNavigateOptional();
  const { announce, LiveRegion } = useLiveAnnouncer();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [enabled, setEnabled] = React.useState(true);
  const [retrievalEnabled, setRetrievalEnabled] = React.useState(true);
  const [authoringStandard, setAuthoringStandard] = React.useState<
    RunbookAuthoringStandardContract | undefined
  >(undefined);
  const [runbooks, setRunbooks] = React.useState<Runbook[]>([]);
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<RunbookFilter>('all');
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceMode, setWorkspaceMode] = React.useState<WorkspaceMode>('view');
  const [detail, setDetail] = React.useState<RunbookDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [draftId, setDraftId] = React.useState('');
  const [draftContent, setDraftContent] = React.useState('');
  const [backendIssues, setBackendIssues] = React.useState<RunbookAuthoringIssue[]>([]);
  const [workspaceError, setWorkspaceError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [reindexing, setReindexing] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [lastIndex, setLastIndex] = React.useState<RunbookIndexResult | null>(null);
  const jobSubmissionIntentRef = React.useRef<JobSubmissionIntent | null>(null);

  const load = React.useCallback(async (blocking = true) => {
    if (blocking) setLoading(true);
    setError(null);
    try {
      const result = await api.getRunbooks();
      setEnabled(result.enabled);
      setRetrievalEnabled(result.retrieval_enabled);
      setAuthoringStandard(result.authoring_standard);
      setRunbooks(
        [...(result.runbooks ?? [])].sort((a, b) =>
          (a.title || a.id).localeCompare(b.title || b.id),
        ),
      );
    } catch (caught) {
      setError(caught);
    } finally {
      if (blocking) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return runbooks.filter((runbook) => {
      if (filter === 'operator' && runbook.source_type !== 'operator') return false;
      if (filter === 'bundled' && runbook.source_type !== 'bundled') return false;
      if (filter === 'attention' && !needsIndexAttention(runbook)) return false;
      if (!needle) return true;
      const haystack = [
        runbook.id,
        runbook.title,
        runbook.summary,
        runbook.persona,
        ...runbook.applies_to_rules,
        ...runbook.applies_to_techniques,
        ...runbook.applies_to_entities,
        ...runbook.keywords,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [filter, query, runbooks]);
  const hasActiveFilters = query.trim() !== '' || filter !== 'all';

  const dirty = React.useMemo(() => {
    if (workspaceMode === 'create') return Boolean(draftId || draftContent);
    if (workspaceMode === 'edit' && detail) return draftContent !== detail.content;
    return false;
  }, [detail, draftContent, draftId, workspaceMode]);
  useUnsavedChanges(dirty && workspaceOpen);

  const authoringValidation = React.useMemo(
    () => validateRunbookAuthoring(draftContent, workspaceMode === 'edit' ? detail?.id : draftId),
    [detail?.id, draftContent, draftId, workspaceMode],
  );
  const validationIssues = React.useMemo(() => {
    const seen = new Set<string>();
    const mismatch = authoringPolicyMismatch(authoringStandard);
    return [
      ...(mismatch ? [mismatch] : []),
      ...backendIssues,
      ...authoringValidation.issues,
    ].filter((issue) => {
      const key = `${issue.code}:${issue.field}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [authoringStandard, authoringValidation.issues, backendIssues]);

  const openRunbook = React.useCallback(async (runbook: Runbook) => {
    setWorkspaceOpen(true);
    setWorkspaceMode('view');
    setDetail(null);
    setWorkspaceError('');
    setBackendIssues([]);
    setDetailLoading(true);
    try {
      const opened = await api.getRunbook(runbook.id);
      setDetail(opened);
      setDraftId(opened.id);
      setDraftContent(opened.content);
    } catch (caught) {
      setWorkspaceError(errorMessage(caught, 'Could not open the runbook.'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const startCreate = React.useCallback(() => {
    setWorkspaceOpen(true);
    setWorkspaceMode('create');
    setDetail(null);
    setDraftId('');
    setDraftContent(runbookTemplate());
    setWorkspaceError('');
    setBackendIssues([]);
    setDetailLoading(false);
  }, []);

  const changeMode = React.useCallback(
    (mode: WorkspaceMode) => {
      if (mode === 'edit' && detail) setDraftContent(detail.content);
      if (mode === 'view' && detail) setDraftContent(detail.content);
      setWorkspaceError('');
      setBackendIssues([]);
      setWorkspaceMode(mode);
    },
    [detail],
  );

  const changeDraftId = React.useCallback((id: string) => {
    setDraftId(id);
    setDraftContent((current) => replaceFrontmatterId(current, id));
    setBackendIssues([]);
    setWorkspaceError('');
  }, []);

  const changeDraftContent = React.useCallback((content: string) => {
    setDraftContent(content);
    setBackendIssues([]);
    setWorkspaceError('');
  }, []);

  const recordIndexResult = React.useCallback(
    (result: RunbookIndexResult, successLabel: string) => {
      setLastIndex(result);
      const summary = describeIndex(result);
      if (result.ok && result.failed === 0) {
        toast.success(`${successLabel} ${summary}.`);
      } else {
        toast.warning(`${successLabel} The Markdown is durable; indexing needs attention. ${summary}.`);
      }
      announce(`${successLabel} ${summary}`);
    },
    [announce],
  );

  const saveRunbook = React.useCallback(async () => {
    if (workspaceMode !== 'create' && !detail) return;
    const id = workspaceMode === 'create' ? draftId.trim() : detail?.id ?? '';
    if (!id || !draftContent.trim() || validationIssues.length) return;
    setSaving(true);
    setWorkspaceError('');
    setBackendIssues([]);
    try {
      const result =
        workspaceMode === 'create'
          ? await api.createRunbook({ id, content: draftContent })
          : await api.updateRunbook(id, draftContent, detail?.revision ?? '');
      setRunbooks((current) => upsertRunbook(current, result.runbook));
      recordIndexResult(
        result.index,
        workspaceMode === 'create' ? 'Runbook created.' : 'Runbook updated.',
      );
      try {
        const opened = await api.getRunbook(result.runbook.id);
        setDetail(opened);
        setDraftId(opened.id);
        setDraftContent(opened.content);
        setWorkspaceMode('view');
        setBackendIssues([]);
      } catch (caught) {
        const message = `Runbook saved, but could not be reopened. ${errorMessage(
          caught,
          'Try opening it again from the list.',
        )}`;
        setDetail(null);
        setWorkspaceMode('view');
        setWorkspaceError(message);
      }
    } catch (caught) {
      const structured = extractRunbookBackendIssues(caught);
      if (structured.length) {
        const message = `Runbook rejected—fix ${structured.length} ${structured.length === 1 ? 'issue' : 'issues'} below.`;
        setBackendIssues(structured);
        setWorkspaceError('');
        toast.error(message);
        announce(message);
      } else {
        const message = errorMessage(caught, 'Could not save the runbook.');
        setBackendIssues([]);
        setWorkspaceError(message);
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  }, [
    announce,
    validationIssues.length,
    detail,
    draftContent,
    draftId,
    recordIndexResult,
    workspaceMode,
  ]);

  const submitReindex = React.useCallback(
    async (runbookId: string | undefined, label: string) => {
      setReindexing(runbookId ?? '*');
      const params = runbookId ? { runbook_id: runbookId } : {};
      const intent = retainJobSubmissionIntent(
        jobSubmissionIntentRef.current,
        'runbook_reindex',
        params,
      );
      jobSubmissionIntentRef.current = intent;
      try {
        const job = await api.jobs.submit({
          kind: 'runbook_reindex',
          idempotency_key: intent.idempotencyKey,
          params,
        });
        jobSubmissionIntentRef.current = null;
        announceJobAccepted(job);
        toast.success(`${label} queued.`, {
          description: 'Reconciliation continues on the server after navigation or reload.',
          action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
        });
        announce(`${label} queued as background job`);
      } catch (caught) {
        const message = errorMessage(caught, 'Could not start the reindex job.');
        toast.error(message);
        announce(message);
      } finally {
        setReindexing(null);
      }
    },
    [announce, navigate],
  );

  const reindexOne = React.useCallback(
    (runbook: Runbook) => submitReindex(runbook.id, runbook.title || runbook.id),
    [submitReindex],
  );

  const reindexAll = React.useCallback(
    () => submitReindex(undefined, 'Runbook reconciliation'),
    [submitReindex],
  );

  const deleteRunbook = React.useCallback(async () => {
    if (!detail?.editable) return;
    setDeleteOpen(false);
    setSaving(true);
    try {
      const result = await api.deleteRunbook(detail.id, detail.revision);
      setRunbooks((current) => current.filter((runbook) => runbook.id !== detail.id));
      recordIndexResult(result.index, 'Runbook deleted.');
      setWorkspaceOpen(false);
      setDetail(null);
      setDraftContent('');
      setDraftId('');
    } catch (caught) {
      const message = errorMessage(caught, 'Could not delete the runbook.');
      setWorkspaceError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [detail, recordIndexResult]);

  const requestWorkspaceOpen = React.useCallback(
    (open: boolean) => {
      if (!open && dirty && !saving) {
        setDiscardOpen(true);
        return;
      }
      if (!saving) setWorkspaceOpen(open);
    },
    [dirty, saving],
  );

  if (loading) {
    return (
      <LoadingState
        layout="panel"
        shape="panel"
        label="Loading runbooks"
        description="Preparing trusted investigation references and their retrieval state."
      />
    );
  }
  if (error) {
    return <LoadError error={error} title="Could not load runbooks" onRetry={() => void load()} />;
  }

  return (
    <div className="space-y-6">
      <LiveRegion />
      {embedded ? null : (
        <PageHeader
          icon={BookMarked}
          eyebrow="Intelligence"
          title="Runbooks"
          description="Author trusted reference knowledge the agent can retrieve during investigations."
        />
      )}

      <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-1.5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Runbooks are retrieval references for investigation context. Playbooks remain the
            separate procedure layer, and deterministic case policy remains final authority.
          </p>
          <p className="text-xs text-muted-foreground">
            {runbooks.length} loaded · {runbooks.filter((item) => item.source_type === 'operator').length}{' '}
            operator · {runbooks.filter(needsIndexAttention).length} need indexing attention
          </p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => void reindexAll()}
              disabled={Boolean(reindexing)}
            >
              <RefreshCw
                className={
                  reindexing === '*'
                    ? 'size-4 animate-spin motion-reduce:animate-none'
                    : 'size-4'
                }
                aria-hidden="true"
              />
              {reindexing === '*' ? 'Submitting…' : 'Reindex all'}
            </Button>
            <Button onClick={startCreate}>
              <Plus className="size-4" aria-hidden="true" />
              New runbook
            </Button>
          </div>
        ) : null}
      </div>

      {!enabled || !retrievalEnabled ? (
        <Alert variant="warning">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Runbook retrieval is not active</AlertTitle>
          <AlertDescription>
            {!enabled
              ? 'Runbooks are disabled. Changes remain durable, but investigations will not use them until Runbooks is enabled in Settings.'
              : 'RAG retrieval is disabled. Changes remain durable, but investigations cannot retrieve runbook knowledge until retrieval is enabled.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {lastIndex ? (
        <Alert variant={lastIndex.ok && lastIndex.failed === 0 ? 'success' : 'warning'}>
          {lastIndex.ok && lastIndex.failed === 0 ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <AlertCircle aria-hidden="true" />
          )}
          <AlertTitle>Latest index reconciliation</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{describeIndex(lastIndex)}.</p>
            {indexErrors(lastIndex).slice(0, 3).map((message, index) => (
              <p key={`${message}-${index}`} className="break-words">
                {message}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Runbook library">
        <div className="grid gap-3 border-y border-border py-4 md:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="relative">
            <Label htmlFor="runbook-search" className="sr-only">
              Search runbooks
            </Label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="runbook-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles, rules, techniques, entities, or keywords…"
              className="pl-9"
            />
          </div>
          <Select value={filter} onValueChange={(value) => setFilter(value as RunbookFilter)}>
            <SelectTrigger aria-label="Filter runbooks">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All runbooks</SelectItem>
              <SelectItem value="operator">Operator owned</SelectItem>
              <SelectItem value="bundled">Bundled references</SelectItem>
              <SelectItem value="attention">Needs indexing attention</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {filtered.length ? (
          <div>
            {filtered.map((runbook) => (
              <RunbookRow
                key={runbook.id}
                runbook={runbook}
                canManage={canManage}
                reindexing={reindexing === runbook.id}
                onOpen={(item) => void openRunbook(item)}
                onReindex={(item) => void reindexOne(item)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            state={hasActiveFilters ? 'no-results' : 'first-use'}
            title={hasActiveFilters ? 'No runbooks match these filters' : 'No runbooks are available'}
            description={
              hasActiveFilters
                ? 'The library loaded, but the current search and ownership or indexing filter exclude every runbook. Clear the filters to return to the full library.'
                : canManage
                  ? 'This library has no bundled or operator-authored references yet. Use New runbook to create operator guidance, then index it to make the guidance retrievable.'
                  : 'This library has no bundled or operator-authored references yet. Ask a runbook manager to add and index trusted guidance.'
            }
            action={
              hasActiveFilters ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  <X className="size-4" aria-hidden="true" />
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}
      </section>

      <div className="flex items-start gap-3 border-t border-border pt-5 text-xs leading-relaxed text-muted-foreground">
        <Tags className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          Applicability metadata improves retrieval precision; it does not execute a runbook or
          make a verdict. Open a runbook to inspect the exact Markdown and projection revision.
        </p>
      </div>

      <RunbookWorkspace
        open={workspaceOpen}
        mode={workspaceMode}
        detail={detail}
        loading={detailLoading}
        saving={saving}
        reindexing={reindexing === detail?.id}
        draftId={draftId}
        draftContent={draftContent}
        validationIssues={validationIssues}
        bodyCharacters={authoringValidation.bodyCharacters}
        descriptorCharacters={authoringValidation.descriptorCharacters}
        error={workspaceError}
        canManage={canManage}
        authoringStandard={authoringStandard}
        onOpenChange={requestWorkspaceOpen}
        onModeChange={changeMode}
        onDraftIdChange={changeDraftId}
        onDraftContentChange={changeDraftContent}
        onSave={() => void saveRunbook()}
        onReindex={() => {
          if (detail) void reindexOne(detail);
        }}
        onDelete={() => setDeleteOpen(true)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this runbook?"
        description={
          detail
            ? `${detail.title || detail.id} and its retrieval projection will be removed. Bundled runbooks cannot be deleted.`
            : 'The operator runbook and its retrieval projection will be removed.'
        }
        confirmLabel="Delete runbook"
        destructive
        onConfirm={() => void deleteRunbook()}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard unsaved changes?"
        description="Your Markdown changes have not been saved."
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          setDiscardOpen(false);
          setWorkspaceOpen(false);
          setWorkspaceMode('view');
          setWorkspaceError('');
          if (detail) setDraftContent(detail.content);
        }}
      />
    </div>
  );
}
