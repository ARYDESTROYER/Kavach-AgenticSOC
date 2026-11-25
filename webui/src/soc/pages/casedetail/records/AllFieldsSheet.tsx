/**
 * "View all fields": every stored field of the case in a searchable JSON tree, with Copy
 * JSON and Download (Round 16 SPEC §4.5 WP14, research data-visibility R11). It reads
 * the stored case through `GET /api/cases/{id}/export?format=json` when it opens, so a
 * field a later release adds is visible here before it has a designed home. The server
 * leaves the spend out (`token_cost` null) for a viewer without `cost:view`; the sheet
 * says so.
 *
 * Every value is a text node inside the tree (#9): a case carries model, source and
 * person-written text. Read only: nothing here changes the case (#3).
 */
import * as React from 'react';

import { getCaseRecord, type CaseRecordExport } from '@/lib/api-case-records';
import { errorMessage } from '@/lib/errorMessage';

import { LoadingState } from '@/design-system';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Button } from '@/ui/button';

import { useAuth } from '@/soc/auth';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { JsonViewer } from '@/soc/components/JsonTree';

export interface AllFieldsSheetProps {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Injectable for tests. */
  load?: (caseId: string, signal?: AbortSignal) => Promise<CaseRecordExport>;
}

type Loaded =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; record: CaseRecordExport; value: unknown; parsed: boolean };

/** A file name the browser keeps as it is: the server's, else one built from the id. */
function safeFilename(name: string, caseId: string): string {
  const clean = name.replace(/[^\w.-]+/g, '_').slice(0, 120);
  return clean && /\.json$/i.test(clean) ? clean : `${caseId.replace(/[^\w.-]+/g, '_').slice(0, 100) || 'case'}.json`;
}

export const AllFieldsSheet: React.FC<AllFieldsSheetProps> = ({ caseId, open, onOpenChange, load = getCaseRecord }) => {
  const { hasPermission } = useAuth();
  const canViewCost = hasPermission('cost', 'view');
  const [loaded, setLoaded] = React.useState<Loaded>({ state: 'idle' });
  const [reload, setReload] = React.useState(0);
  const [announce, setAnnounce] = React.useState('');

  React.useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    setLoaded({ state: 'loading' });
    let pending: Promise<CaseRecordExport>;
    try {
      pending = load(caseId, controller.signal);
    } catch (error) {
      setLoaded({ state: 'error', message: errorMessage(error, 'The case record could not be loaded.') });
      return () => controller.abort();
    }
    pending
      .then((record) => {
        if (controller.signal.aborted) return;
        let value: unknown = record.content;
        let parsed = false;
        try {
          value = JSON.parse(record.content);
          parsed = true;
        } catch {
          /* not JSON: shown as text below */
        }
        setLoaded({ state: 'ready', record, value, parsed });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({ state: 'error', message: errorMessage(error, 'The case record could not be loaded.') });
      });
    return () => controller.abort();
  }, [open, caseId, load, reload]);

  const fieldCount =
    loaded.state === 'ready' && loaded.parsed && loaded.value && typeof loaded.value === 'object'
      ? Object.keys(loaded.value as Record<string, unknown>).length
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="lg" className="gap-0 overflow-y-auto p-0" data-testid="all-fields-sheet">
        <div className="flex min-h-0 flex-col gap-4 p-5 pt-4">
          <SheetHeader className="pr-12 text-left">
            <SheetTitle>All fields</SheetTitle>
            <SheetDescription>
              Every field this case stores, exactly as the record holds it.
              {fieldCount !== null ? ` ${fieldCount.toLocaleString('en-US')} top-level fields.` : ''}
            </SheetDescription>
          </SheetHeader>
          {!canViewCost ? (
            <p className="text-xs text-muted-foreground" data-testid="all-fields-cost-withheld">
              Costs are left out. They need permission to view costs.
            </p>
          ) : null}
          <p aria-live="polite" className="sr-only">
            {announce}
          </p>
          {loaded.state === 'loading' || loaded.state === 'idle' ? (
            <LoadingState label="Loading the case record" layout="panel" shape="rows" shapeRows={6} />
          ) : null}
          {loaded.state === 'error' ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <p role="alert" className="text-critical-text">
                {loaded.message}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : null}
          {loaded.state === 'ready' ? (
            loaded.parsed ? (
              <JsonViewer
                value={loaded.value}
                label="Case record"
                text={loaded.record.content}
                filename={safeFilename(loaded.record.filename, caseId)}
                onCopied={(ok) => setAnnounce(ok ? 'Copied the case record.' : 'Could not copy the case record.')}
              />
            ) : (
              /* Not JSON: the exact text, fenced (#9). */
              <CodeBlock value={loaded.record.content} caption="case record" wrap copyable maxHeightClassName="max-h-[70vh]" />
            )
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
};
