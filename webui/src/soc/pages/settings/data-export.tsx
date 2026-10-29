/**
 * Data export settings section: durable, server-assembled portable export jobs (Round 14
 * grouped panels).
 */
import * as React from 'react';
import { Archive } from 'lucide-react';
import { toast } from 'sonner';

import type { DataExportScope } from '@/lib/api';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errorMessage';
import { LoadingGlyph } from '@/design-system';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { Can } from '@/soc/components/Can';
import {
  announceJobAccepted,
  retainJobSubmissionIntent,
  type JobSubmissionIntent,
} from '@/soc/jobs/jobs';
import { useNavigateOptional } from '@/soc/router';
import { SettingRow, SettingsGroup, SettingsSection } from './primitives';

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
const SEGMENT_OPTIONS = SEGMENT_SIZES.map((value) => ({ value: String(value), label: value.toLocaleString('en-US') }));

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
      <SettingsSection title="Data export">
        <SettingsGroup
          title="Assembly"
          caption="The server builds and verifies one ZIP before Download appears in Inbox. Leaving this page does not cancel the job."
        >
          <SettingRow variant="block">
            <fieldset disabled={submitting}>
              <legend className="sr-only">Assembly mode</legend>
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as ExportMode)}
                className="space-y-3"
                aria-label="Export assembly mode"
              >
                <label htmlFor="export-mode-archive" className="flex cursor-pointer items-start gap-3">
                  <RadioGroupItem id="export-mode-archive" value="archive" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-base font-medium text-foreground">Archive</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      Assemble the selected data straight into one ZIP.
                    </span>
                  </span>
                </label>
                <label htmlFor="export-mode-segment" className="flex cursor-pointer items-start gap-3">
                  <RadioGroupItem id="export-mode-segment" value="segment" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-base font-medium text-foreground">Segmented assembly</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      Follow bounded server cursors, then package every segment into one ZIP.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </fieldset>
          </SettingRow>
          {mode === 'segment' ? (
            <SettingRow
              variant="select"
              label="Records per server segment"
              help="A server memory bound; the final delivery is still one ZIP."
              value={String(segmentSize)}
              options={SEGMENT_OPTIONS}
              disabled={submitting}
              onValueChange={(value) => setSegmentSize(Number(value))}
              controlWidth="10rem"
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup title="Data to include">
          <SettingRow variant="block">
            <fieldset disabled={submitting}>
              <legend className="sr-only">Data to include</legend>
              <label className="flex cursor-pointer items-start gap-3">
                <Checkbox
                  checked={allSelected ? true : selected.length ? 'indeterminate' : false}
                  onCheckedChange={(value) => toggleAll(value === true)}
                  aria-label="Select all export scopes"
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-base font-medium text-foreground">Everything</span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">Every supported secret-free scope.</span>
                </span>
              </label>
              <div className="mt-3 grid gap-x-6 gap-y-3 border-t border-border/70 pt-3 sm:grid-cols-2">
                {SCOPES.map((scope) => (
                  <label key={scope.id} className="flex cursor-pointer items-start gap-3">
                    <Checkbox
                      checked={selected.includes(scope.id)}
                      onCheckedChange={(value) => toggleScope(scope.id, value === true)}
                      aria-label={`Include ${scope.title}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-base font-medium text-foreground">{scope.title}</span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">{scope.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </SettingRow>
          <SettingRow
            variant="action"
            label="Build the export"
            help="Needs the data export permission and a fresh sign-in. Every job is recorded in the audit log."
            action={
              <Button onClick={() => void submitExport()} disabled={!selected.length || submitting} aria-busy={submitting || undefined}>
                {submitting ? <LoadingGlyph size="sm" className="size-4" /> : <Archive className="h-4 w-4" aria-hidden />}
                Build ZIP in background
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </Can>
  );
}

export default DataExportSection;
