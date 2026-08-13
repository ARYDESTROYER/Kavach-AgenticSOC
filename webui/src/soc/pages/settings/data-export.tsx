/** Durable, server-assembled portable export jobs. */
import * as React from 'react';
import { Archive, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import type { DataExportScope } from '@/lib/api';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Can } from '@/soc/components/Can';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';
import { useNavigateOptional } from '@/soc/router';
import { SectionTitle } from './primitives';

type ExportScope = DataExportScope;
type ExportMode = 'archive' | 'segment';

const SCOPES: Array<{ id: ExportScope; title: string; description: string }> = [
  { id: 'cases', title: 'Cases', description: 'Case records, assessments, scores, evidence summaries and lifecycle.' },
  { id: 'audit', title: 'Audit', description: 'Append-only operator and agent action history.' },
  { id: 'usage', title: 'Usage & cost', description: 'Model calls, tokens and recorded cost metadata.' },
  { id: 'configuration', title: 'Configuration', description: 'Non-secret effective settings and source manifests.' },
  { id: 'automation', title: 'Automation', description: 'Proposals, tuning state, campaigns, batch jobs and rule-version history.' },
  { id: 'knowledge', title: 'Knowledge', description: 'Safe document metadata, operator memory and custom-model registrations.' },
];

const SEGMENT_SIZES = [500, 1000, 2500, 5000];

export function DataExportSection() {
  const navigate = useNavigateOptional();
  const [selected, setSelected] = React.useState<ExportScope[]>(SCOPES.map((scope) => scope.id));
  const [mode, setMode] = React.useState<ExportMode>('archive');
  const [segmentSize, setSegmentSize] = React.useState(1000);
  const [submitting, setSubmitting] = React.useState(false);
  const intentRef = React.useRef<JobSubmissionIntent | null>(null);

  const allSelected = selected.length === SCOPES.length;
  const toggleAll = (checked: boolean) =>
    setSelected(checked ? SCOPES.map((scope) => scope.id) : []);
  const toggleScope = (scope: ExportScope, checked: boolean) =>
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((item) => item !== scope),
    );

  const submitExport = async () => {
    if (!selected.length || submitting) return;
    const kind = mode === 'archive' ? 'data_export_archive' : 'data_export_segment';
    const params: Record<string, unknown> = {
      scopes: [...selected].sort(),
      ...(mode === 'segment' ? { page_size: segmentSize } : {}),
    };
    const intent = retainJobSubmissionIntent(intentRef.current, kind, params);
    intentRef.current = intent;
    setSubmitting(true);
    try {
      const job = await api.jobs.submit({
        kind,
        idempotency_key: intent.idempotencyKey,
        params,
      });
      intentRef.current = null;
      announceJobAccepted(job);
      toast.success('Portable export queued and running in the background.', {
        description: 'Progress and the verified ZIP download remain available in Inbox.',
        action: { label: 'Open Inbox', onClick: () => navigate('inbox') },
      });
    } catch (error) {
      toast.error(errorMessage(error, 'Could not queue the portable export.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Can resource="data_export" action="export">
      <div className="space-y-6">
        <SectionTitle
          title="Portable full-history export"
          sub="Build one verified ZIP in the background. Navigation or reload no longer interrupts assembly."
        />

        <fieldset className="space-y-2" disabled={submitting}>
          <legend className="text-sm font-semibold text-foreground">Assembly mode</legend>
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as ExportMode)}
            className="grid gap-2 sm:grid-cols-2"
            aria-label="Export assembly mode"
          >
            <label htmlFor="export-mode-archive" className="flex cursor-pointer items-start gap-3 border border-border p-3">
              <RadioGroupItem id="export-mode-archive" value="archive" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">Archive</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  Assemble selected scopes directly into one ZIP artifact.
                </span>
              </span>
            </label>
            <label htmlFor="export-mode-segment" className="flex cursor-pointer items-start gap-3 border border-border p-3">
              <RadioGroupItem id="export-mode-segment" value="segment" className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">Segmented assembly</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  Follow bounded server cursors, then package every JSON envelope into one ZIP.
                </span>
              </span>
            </label>
          </RadioGroup>
        </fieldset>

        <Alert>
          <ShieldCheck className="h-4 w-4" aria-hidden />
          <AlertTitle>Durable, server-verified artifact</AlertTitle>
          <AlertDescription>
            Credentials, tokens, sessions, users, environment secrets and upstream raw logs are never included. The server assembles and verifies the complete ZIP before exposing Download in Inbox.
          </AlertDescription>
        </Alert>

        <fieldset className="space-y-3" disabled={submitting}>
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
          {mode === 'segment' ? (
            <div className="space-y-1.5">
              <Label htmlFor="export-segment-size">Records per server segment</Label>
              <Select value={String(segmentSize)} onValueChange={(value) => setSegmentSize(Number(value))} disabled={submitting}>
                <SelectTrigger id="export-segment-size" className="w-52" aria-label="Records per server segment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEGMENT_SIZES.map((value) => <SelectItem key={value} value={String(value)}>{value.toLocaleString()}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">A server memory bound; the final delivery is still one ZIP.</p>
            </div>
          ) : (
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              Leaving this page does not cancel the job. Inbox is the durable progress and download surface.
            </p>
          )}
          <Button onClick={() => void submitExport()} disabled={!selected.length || submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Archive className="h-4 w-4" aria-hidden />}
            {submitting ? 'Queuing export…' : 'Build ZIP in background'}
          </Button>
        </div>

        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Requires <code className="font-mono text-foreground">data_export:export</code> and a fresh sign-in. Every job is recorded in the audit trail.
          </span>
        </div>
      </div>
    </Can>
  );
}

export default DataExportSection;
