/**
 * The Reinvestigate dialog (Round 16 SPEC §4.5 WP09, research ai-investigating R4).
 *
 * NON-BLOCKING. It posts `wait: false`, closes on the `202` and hands the run to the
 * investigation store (`noteReinvestigationStarted`), so the case header chip shows at
 * once; you keep working while the run goes on. A second request while a run is queued
 * or running answers `409 investigation_running`, shown as a toast. A closed case whose
 * events another open case now holds answers `409 open_case_exists`, also a toast with
 * the server's words. A refusal (403) is worded, never the raw permission string.
 *
 * When a run on this case finishes while the case is open (this one or any other), the
 * dialog reads the case again and hands it to `onReinvestigated`, so the case shows the
 * run's result. A toast says so for your own run, or when the status changed under you:
 * "AI investigation finished on CASE-0042: <status words>." When the case on screen was
 * closed or resolved and the run left it open, the toast is a warning that says the run
 * replaced the close (FXB). No toast shows while a close or status dialog's run note
 * covers the case: the note already says the run finished, and a toast would sit over the
 * dialog's buttons. The toast's end is marked as said (`announce.ts`), so the header chip
 * does not say it again. Nothing here decides anything: the run's result comes from the
 * server (#3).
 */
import * as React from 'react';
import { AlertTriangle, LoaderCircle, Play, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import type { Case, InvestigationView, ModelsResponse } from '@/lib/types';
import { useAuth } from '@/soc/auth';
import { isTerminalStatus } from '@/soc/components/outcome';
import { statusWords } from '@/soc/pages/casedetail/caseFacts';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';

import { capWords } from './AiRunPopover';
import { noteRunEnd, runEndSaid, runNoticeOpen } from './announce';
import { noteReinvestigationStarted, reconcileInvestigations, useInvestigations } from './store';
import { useAiRunFinished } from './useAiRun';

export interface ReinvestigateDialogProps {
  caseRecord: Case | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The models the picker offers (best effort; `null` offers the configured model only). */
  models: ModelsResponse | null;
  /** The case after a run on it finished (read again when the run ends). */
  onReinvestigated?: (next: Case) => void;
  /** Where focus returns when the dialog closes (the control that opened it). */
  onCloseAutoFocus?: (event: Event) => void;
}

/** The `202` body of a reinvestigation that does not wait for its run. */
export interface ReinvestigationStarted {
  run_id: string;
  case_id: string;
  state: 'queued';
}

/**
 * `POST /api/cases/{id}/reinvestigate` with `wait: false` (`cases:reinvestigate`): the
 * run starts in the background and the route answers `202` at once. It goes through the
 * existing client call, which forwards the body as is; without `wait` that call still
 * waits for the run and answers the case, as before.
 */
export function startReinvestigation(caseId: string, input: { model?: string } = {}): Promise<ReinvestigationStarted> {
  const body = { ...input, wait: false } as { model?: string };
  return api.reinvestigateCase(caseId, body) as unknown as Promise<ReinvestigationStarted>;
}

/** The `code` of a refused call (`{detail: {code}}`), when it has one. */
export function refusalCode(error: unknown): string | null {
  const detail = ((error as { body?: { detail?: unknown } } | null)?.body?.detail ?? null) as { code?: unknown } | null;
  return typeof detail?.code === 'string' ? detail.code : null;
}

export const ALREADY_RUNNING_TEXT = 'An AI investigation is already running on this case.';

/**
 * The toast for a reinvestigation that did not start. A refusal (403: the grant is
 * missing, or was removed after the case opened) is worded, never the server's raw
 * "permission denied: cases:reinvestigate"; any other failure keeps its message.
 */
export function reinvestigateErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'You do not have permission to reinvestigate cases.';
  if (refusalCode(error) === 'investigation_running') return ALREADY_RUNNING_TEXT;
  return error instanceof Error && error.message ? error.message : 'The reinvestigation could not be started.';
}

/** "AI investigation finished on CASE-0042: Open · awaiting analyst." and the like. */
export function finishedToastText(run: InvestigationView, caseLabel: string): string {
  if (run.outcome === 'cancelled') return `The AI investigation on ${caseLabel} stopped before it finished. The case was not changed.`;
  if (run.outcome === 'failed') return `The AI investigation on ${caseLabel} could not finish.`;
  if (run.outcome === 'unchanged') return `AI investigation finished on ${caseLabel}: no change to the case.`;
  return run.status_after
    ? `AI investigation finished on ${caseLabel}: ${statusWords(run.status_after)}.`
    : `AI investigation finished on ${caseLabel}.`;
}

/**
 * Who closed the case on screen, from its last status change into a closed or resolved
 * status (null when the record does not say).
 */
export function closedBy(c: Case | null | undefined): string | null {
  const history = Array.isArray(c?.status_history) ? c.status_history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (isTerminalStatus(entry?.to_status)) return typeof entry.by === 'string' && entry.by.trim() ? entry.by.trim() : null;
  }
  return null;
}

/**
 * The warning for a run that replaced a close: the case on screen was closed or resolved,
 * and the run left it open. "your close" when the record says you closed it.
 */
export function replacedCloseToastText(caseLabel: string, statusAfter: unknown, yours: boolean): string {
  return `The AI investigation replaced ${yours ? 'your' : 'the'} close of ${caseLabel}. Status: ${statusWords(statusAfter)}. ${
    yours ? 'Your' : 'The'
  } disposition and note are kept.`;
}

/** Outcomes after which the stored case may differ from the one on screen. */
const CHANGED = new Set(['decided', 'closed_by_policy', 'routed_to_person']);

export const ReinvestigateDialog: React.FC<ReinvestigateDialogProps> = ({
  caseRecord,
  open,
  onOpenChange,
  models,
  onReinvestigated,
  onCloseAutoFocus,
}) => {
  const { hasPermission, username } = useAuth();
  const canViewCost = hasPermission('cost', 'view');
  const [reinvestModel, setReinvestModel] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const caseId = caseRecord?.case_id ?? '';
  const timeCap = useInvestigations((s) => s.timeCapSeconds, Boolean(caseId));

  const modelOptions = React.useMemo<Array<{ value: string; text: string }>>(() => {
    const out: Array<{ value: string; text: string }> = [];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list || []) {
        out.push({ value: m, text: `${m}  ·  ${provider}` });
      }
    }
    return out;
  }, [models]);

  const runReinvestigate = React.useCallback(async () => {
    if (!caseId) return;
    setStarting(true);
    try {
      const input = reinvestModel.trim() ? { model: reinvestModel.trim() } : {};
      const started = await startReinvestigation(caseId, input);
      if (started?.run_id) noteReinvestigationStarted(caseId, started.run_id);
      onOpenChange(false);
    } catch (e) {
      if (refusalCode(e) === 'investigation_running') {
        toast.info(ALREADY_RUNNING_TEXT);
        // The run may be one this console has not seen (no live stream): read it, so the
        // header chip shows the run the toast speaks of.
        void reconcileInvestigations(caseId);
        onOpenChange(false);
      } else {
        toast.error(reinvestigateErrorText(e));
      }
    } finally {
      setStarting(false);
    }
  }, [caseId, reinvestModel, onOpenChange]);

  // A run on this case finished while it is open: read the case again so it shows the
  // result, and say so for your own run or when the status changed under you. The case
  // on screen may blank for a moment while it reloads (`caseRecord` null), so the open
  // time and the case follow the last case shown, and a read in flight is dropped only
  // when the dialog goes or another case opens. A quick run can end before its `202`
  // says it is yours: the store then marks it, and this effect runs again for it.
  const done = useAiRunFinished(caseId || null);
  const opened = React.useRef({ id: '', at: Date.now() });
  const tracked = React.useRef<{ runId: string; state: 'waiting' | 'reading' | 'read'; told: boolean } | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (caseId && caseId !== opened.current.id) opened.current = { id: caseId, at: Date.now() };
  }, [caseId]);
  const shownRef = React.useRef<Case | null>(caseRecord);
  if (caseRecord) shownRef.current = caseRecord;
  const onDoneRef = React.useRef(onReinvestigated);
  onDoneRef.current = onReinvestigated;
  const latestRef = React.useRef<InvestigationView | null>(null);
  latestRef.current = done?.view ?? null;
  React.useEffect(() => {
    const run = done?.view;
    if (!run || !caseId || run.case_id !== caseId) return;
    let t = tracked.current;
    if (!t || t.runId !== run.run_id) t = tracked.current = { runId: run.run_id, state: 'waiting', told: false };
    const entry = t;
    const label = shownRef.current?.case_number || 'this case';
    const changed = CHANGED.has(run.outcome || '');
    /** `replaced`: who made the close on screen that the run's result replaced, and the status now. */
    const tell = (
      latest: InvestigationView,
      moved: boolean,
      replaced: { by: string | null; status: unknown } | null = null,
    ) => {
      if (entry.told || !(moved || (latest.run_id === entry.runId && latest.requested_by_you))) return;
      entry.told = true;
      // A close or status dialog's note covers the case and says the run finished: no
      // toast over the dialog's buttons (the note marks the end as said).
      if (runNoticeOpen(caseId)) return;
      noteRunEnd(entry.runId, 'said');
      if (replaced) {
        const yours = Boolean(replaced.by && username && replaced.by.toLowerCase() === username.toLowerCase());
        toast.warning(replacedCloseToastText(label, replaced.status, yours));
        return;
      }
      (changed ? toast.success : toast.info)(finishedToastText(latest, label));
    };
    // The same run again, once read: only its requester can have become known.
    if (entry.state === 'read') return tell(run, false);
    if (entry.state === 'reading') return;
    // Only a run this console followed, ending after the case opened: one that ended
    // before is already in what the case loaded.
    if (!done.active || done.at < opened.current.at) return;
    if (!changed) {
      entry.state = 'read';
      return tell(run, false);
    }
    entry.state = 'reading';
    // A toast may follow the read: the header chip waits for it before it says the end.
    noteRunEnd(entry.runId, 'pending');
    const shown = shownRef.current;
    void api
      .getCase(caseId)
      .then((next) => {
        if (!mounted.current || opened.current.id !== caseId || !next || next.case_id !== caseId) {
          if (runEndSaid(entry.runId) === 'pending') noteRunEnd(entry.runId, null);
          return;
        }
        entry.state = 'read';
        onDoneRef.current?.(next);
        // The case on screen was closed or resolved, and the run left it open.
        const replaced =
          isTerminalStatus(shown?.status) && !isTerminalStatus(next.status)
            ? { by: closedBy(shown), status: next.status }
            : null;
        tell(latestRef.current ?? run, Boolean(shown?.status) && next.status !== shown?.status, replaced);
        if (runEndSaid(entry.runId) === 'pending') noteRunEnd(entry.runId, null);
      })
      .catch(() => {
        entry.state = 'read';
        if (runEndSaid(entry.runId) === 'pending') noteRunEnd(entry.runId, null);
      });
  }, [done, caseId, username]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Re-run the investigation
          </DialogTitle>
          <DialogDescription>
            {timeCap
              ? `Runs a fresh AI investigation. It can take up to the investigation time cap (${capWords(timeCap)}). `
              : 'Runs a fresh AI investigation. It can take up to the investigation time cap. '}
            You can keep working; the result appears on the case when it finishes.
          </DialogDescription>
        </DialogHeader>
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Costs tokens and overwrites the verdict</AlertTitle>
          <AlertDescription>
            {canViewCost && caseRecord?.token_cost != null
              ? `Investigation cost to date ${fmtMoney(caseRecord.token_cost)}. `
              : null}
            Re-running spends more tokens and replaces the current verdict, confidence, and
            rationale.
          </AlertDescription>
        </Alert>
        <div className="space-y-1.5">
          <Label className="text-xs">Model</Label>
          <Select
            value={reinvestModel || '__configured__'}
            onValueChange={(value) => setReinvestModel(value === '__configured__' ? '' : value)}
            disabled={starting}
          >
            <SelectTrigger aria-label="Model">
              <SelectValue placeholder="Use configured model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__configured__">Use configured model</SelectItem>
              {modelOptions.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  {model.text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void runReinvestigate()} disabled={starting || !caseId}>
            {starting ? (
              <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
            ) : (
              <Play className="h-4 w-4" aria-hidden />
            )}
            Reinvestigate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
