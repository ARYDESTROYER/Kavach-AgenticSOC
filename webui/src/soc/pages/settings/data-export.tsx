/** RBAC-gated, secret-free archive export with an advanced resumable mode. */
import * as React from 'react';
import { Download, Loader2, LockKeyhole, ShieldCheck, Square } from 'lucide-react';
import { toast } from 'sonner';

import { api, type DataExportScope } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Progress } from '@/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Can } from '@/soc/components/Can';
import { SectionTitle } from './primitives';

type ExportScope = DataExportScope;
type ExportMode = 'archive' | 'resumable';

interface SegmentExport {
  format: 'agentic-soc-portable-export-segment' | string;
  format_version: 2 | number;
  selection: { scope: ExportScope };
  consistency: { mode: string; exact: boolean; detail: string };
  segment: {
    number: number;
    count: number;
    cumulative_count: number;
    snapshot_total: number | null;
    remaining: number | null;
    complete: boolean;
    status: 'partial' | 'complete' | 'incomplete' | 'unverified' | string;
    next_cursor: string | null;
  };
  records: unknown[];
}

interface ExportProgress {
  scope: ExportScope;
  scopeNumber: number;
  records: number;
  total: number | null;
  files: number;
}

const SCOPES: Array<{ id: ExportScope; title: string; description: string }> = [
  { id: 'cases', title: 'Cases', description: 'Case records, assessments, scores, evidence summaries and lifecycle.' },
  { id: 'audit', title: 'Audit', description: 'Append-only operator and agent action history.' },
  { id: 'usage', title: 'Usage & cost', description: 'Model calls, tokens and recorded cost metadata.' },
  { id: 'configuration', title: 'Configuration', description: 'Non-secret effective settings and source manifests.' },
  { id: 'automation', title: 'Automation', description: 'Proposals, tuning state, campaigns, batch jobs and rule-version history.' },
  { id: 'knowledge', title: 'Knowledge', description: 'Safe document metadata, operator memory and custom-model registrations.' },
];

// This is a per-file response/memory bound, never a lifetime ceiling.
const SEGMENT_SIZES = [500, 1000, 2500, 5000];

function downloadJson(value: unknown, filename: string): void {
  // Preserve the server's compact segment bound. Pretty-printing can materially
  // inflate a response that was deliberately kept below 25 MiB.
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const revokeObjectUrl = URL.revokeObjectURL;
  window.setTimeout(() => revokeObjectUrl(url), 0);
}

function fallbackArchiveFilename(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `agentic-soc-export-${timestamp}.zip`;
}

function safeArchiveFilename(candidate: string): string | null {
  const basename = candidate
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.trim();
  if (!basename || basename.length > 180 || !/\.zip$/i.test(basename)) return null;
  const stem = basename
    .slice(0, -4)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!stem || !/[A-Za-z0-9]/.test(stem)) return null;
  return `${stem}.zip`;
}

function unquoteDispositionValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
  }
  return trimmed;
}

function archiveFilename(contentDisposition: string | null): string {
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
          // A malformed filename* does not block the safe filename/fallback path.
        }
      }
    }
    const plain = /(?:^|;)\s*filename\s*=\s*("(?:\\.|[^"])*"|[^;]*)/i.exec(
      contentDisposition,
    )?.[1];
    if (plain) candidates.push(unquoteDispositionValue(plain));

    for (const candidate of candidates) {
      const safe = safeArchiveFilename(candidate);
      if (safe) return safe;
    }
  }
  return fallbackArchiveFilename();
}

function segmentFilename(scope: ExportScope, part: number): string {
  return `agentic-soc-${scope}-part-${String(part).padStart(5, '0')}.json`;
}

export function DataExportSection() {
  const [selected, setSelected] = React.useState<ExportScope[]>(SCOPES.map((scope) => scope.id));
  const [mode, setMode] = React.useState<ExportMode>('archive');
  const [segmentSize, setSegmentSize] = React.useState(1000);
  const [exporting, setExporting] = React.useState(false);
  const [progress, setProgress] = React.useState<ExportProgress | null>(null);
  const controllerRef = React.useRef<AbortController | null>(null);
  const activeCursorRef = React.useRef<{ scope: ExportScope; cursor: string } | null>(null);

  React.useEffect(() => () => {
    controllerRef.current?.abort();
    const active = activeCursorRef.current;
    if (active) {
      void api.post('admin/export/segment/cancel', active).catch(() => undefined);
    }
  }, []);

  const allSelected = selected.length === SCOPES.length;
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? SCOPES.map((scope) => scope.id) : []);
  const toggleScope = (scope: ExportScope, checked: boolean) =>
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((item) => item !== scope),
    );

  const cancelExport = () => {
    controllerRef.current?.abort();
    const active = activeCursorRef.current;
    if (active) {
      // Best effort: the server also expires abandoned PITs after ten minutes.
      void api.post('admin/export/segment/cancel', active).catch(() => undefined);
    }
  };

  const runExport = async () => {
    if (!selected.length || exporting) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    activeCursorRef.current = null;
    setExporting(true);
    setProgress(null);
    let totalFiles = 0;
    let totalRecords = 0;
    try {
      if (mode === 'archive') {
        const result = await api.dataExport.archive(selected, controller.signal);
        const contentType = result.contentType?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/zip') {
          throw new Error(
            `The server returned ${contentType || 'no content type'} instead of an application/zip archive. No file was saved.`,
          );
        }
        if (result.blob.size === 0) {
          throw new Error('The server returned an empty ZIP archive. No file was saved.');
        }
        downloadBlob(result.blob, archiveFilename(result.contentDisposition));
        toast.success('Portable export complete · one ZIP archive downloaded.');
      } else {
        for (const [scopeIndex, scope] of selected.entries()) {
          let cursor: string | null = null;
          const cursors = new Set<string>();
          let scopeRecords = 0;
          let scopeFiles = 0;
          do {
            if (controller.signal.aborted) throw new Error('Export cancelled');
            const payload: SegmentExport = await api.postAbortable<SegmentExport>(
              'admin/export/segment',
              { scope, cursor, page_size: segmentSize },
              controller.signal,
            );
            if (payload.format !== 'agentic-soc-portable-export-segment' || payload.format_version !== 2) {
              throw new Error(`The server returned an unsupported ${scope} export format.`);
            }
            if (payload.segment.status === 'incomplete' || payload.segment.status === 'unverified') {
              throw new Error(
                `${scope} stopped without proof of completion (${payload.segment.status}). No complete-export claim was made.`,
              );
            }
            downloadJson(payload, segmentFilename(scope, payload.segment.number));
            scopeFiles += 1;
            totalFiles += 1;
            scopeRecords = payload.segment.cumulative_count;
            totalRecords += payload.segment.count;
            setProgress({
              scope,
              scopeNumber: scopeIndex + 1,
              records: scopeRecords,
              total: payload.segment.snapshot_total,
              files: scopeFiles,
            });
            if (payload.segment.complete) {
              cursor = null;
              activeCursorRef.current = null;
              break;
            }
            const next: string | null = payload.segment.next_cursor;
            if (!next || payload.segment.count <= 0 || cursors.has(next)) {
              throw new Error(`${scope} export made no forward progress; stopped before claiming completion.`);
            }
            cursors.add(next);
            cursor = next;
            activeCursorRef.current = { scope, cursor: next };
          } while (cursor);
        }
        toast.success(
          `Advanced export complete · ${totalRecords.toLocaleString()} records in ${totalFiles.toLocaleString()} numbered files.`,
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        toast.info(
          mode === 'archive'
            ? 'Archive request cancelled. No archive was saved.'
            : 'Export cancelled. Downloaded segments remain valid; the export is not complete.',
        );
      } else {
        const active = activeCursorRef.current;
        if (active) {
          await api.post('admin/export/segment/cancel', active).catch(() => undefined);
        }
        toast.error(
          errorMessage(
            error,
            mode === 'archive'
              ? 'Could not build the ZIP archive. No file was saved.'
              : 'Could not complete the advanced numbered-file export.',
          ),
        );
      }
    } finally {
      controllerRef.current = null;
      activeCursorRef.current = null;
      setExporting(false);
    }
  };

  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.records / progress.total) * 100))
    : undefined;

  return (
    <Can resource="data_export" action="export">
      <div className="space-y-6">
        <SectionTitle
          title="Portable full-history export"
          sub="Download selected safe application state as one server-assembled ZIP, or use the advanced numbered-file workflow."
        />

        <fieldset className="space-y-2" disabled={exporting}>
          <legend className="text-sm font-semibold text-foreground">Delivery mode</legend>
          <RadioGroup
            value={mode}
            onValueChange={(value) => {
              setMode(value as ExportMode);
              setProgress(null);
            }}
            className="grid gap-2 sm:grid-cols-2"
            aria-label="Export delivery mode"
          >
            <label htmlFor="export-mode-archive" className="flex cursor-pointer items-start gap-3 border border-border p-3">
              <RadioGroupItem id="export-mode-archive" value="archive" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">One ZIP archive (recommended)</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  The server assembles the complete archive before the browser saves one file.
                </span>
              </span>
            </label>
            <label htmlFor="export-mode-resumable" className="flex cursor-pointer items-start gap-3 border border-border p-3">
              <RadioGroupItem id="export-mode-resumable" value="resumable" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">Advanced / resumable (numbered files)</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  Download bounded JSON parts when one long archive request is unsuitable.
                </span>
              </span>
            </label>
          </RadioGroup>
        </fieldset>

        <Alert>
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <AlertTitle>
            {mode === 'archive' ? 'One server-assembled archive' : 'Advanced resumable delivery'}
          </AlertTitle>
          <AlertDescription>
            Credentials, tokens, sessions, users, environment secrets and upstream raw logs are never
            included. This is not a full application backup.{' '}
            {mode === 'archive'
              ? 'The server completes assembly and auditing before delivering one ZIP. If that request fails, no file is saved; the request itself is not resumable.'
              : 'The server uses bounded files and continues past 5,000 records. Already downloaded parts remain after cancellation, and exact point-in-time consistency is declared per segment when supported.'}
          </AlertDescription>
        </Alert>

        <fieldset className="space-y-3" disabled={exporting}>
          <legend className="text-sm font-semibold text-foreground">Data to include</legend>
          <label className="flex cursor-pointer items-start gap-3 border-b border-border py-3">
            <Checkbox
              checked={allSelected ? true : selected.length ? 'indeterminate' : false}
              onCheckedChange={(value) => toggleAll(value === true)}
              aria-label="Select all export scopes"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">All supported export scopes</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Include every supported secret-free application scope.</span>
            </span>
          </label>
          <div className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
            {SCOPES.map((scope) => (
              <label key={scope.id} className="flex cursor-pointer items-start gap-3 border-b border-border/70 py-3">
                <Checkbox
                  checked={selected.includes(scope.id)}
                  onCheckedChange={(value) => toggleScope(scope.id, value === true)}
                  aria-label={`Include ${scope.title}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{scope.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{scope.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border pt-5">
          {mode === 'resumable' ? (
            <div className="space-y-1.5">
              <Label htmlFor="export-segment-size">Records per file</Label>
              <Select value={String(segmentSize)} onValueChange={(value) => setSegmentSize(Number(value))} disabled={exporting}>
                <SelectTrigger id="export-segment-size" className="w-44" aria-label="Records per export file">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEGMENT_SIZES.map((value) => <SelectItem key={value} value={String(value)}>{value.toLocaleString()}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">A response safety bound, not a lifetime limit. Your browser may ask to allow multiple downloads.</p>
            </div>
          ) : (
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              One successful request creates one ZIP. Use Advanced mode if you need resumable, numbered downloads.
            </p>
          )}
          <div className="flex gap-2">
            {exporting ? (
              <Button variant="outline" onClick={cancelExport}><Square className="h-3.5 w-3.5" aria-hidden />Cancel</Button>
            ) : null}
            <Button onClick={() => void runExport()} disabled={!selected.length || exporting}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
              {exporting
                ? mode === 'archive' ? 'Building archive…' : 'Exporting full history…'
                : mode === 'archive' ? 'Download ZIP archive' : 'Export numbered files'}
            </Button>
          </div>
        </div>

        {progress ? (
          <div className="space-y-2 border-y border-border py-4" aria-live="polite">
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">{progress.scope} · scope {progress.scopeNumber} of {selected.length}</span>
              <span className="text-muted-foreground">
                {progress.records.toLocaleString()}{progress.total !== null ? ` / ${progress.total.toLocaleString()}` : ''} records · {progress.files} files
              </span>
            </div>
            <Progress value={progressPercent} className="h-1.5" />
          </div>
        ) : null}

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Requires <code className="font-mono text-foreground">data_export:export</code> and a fresh sign-in. Every prepared {mode === 'archive' ? 'archive' : 'segment'} is recorded in the audit trail.
          </span>
        </div>
      </div>
    </Can>
  );
}

export default DataExportSection;
