/**
 * The Reinvestigate dialog (Round 16 SPEC §4.3 WP01 stub; WP09 replaces the body).
 *
 * The stub body is today's Reinvestigate dialog from `CaseDetail.tsx`, moved here
 * unchanged in behaviour: it is blocking (the request waits for the run) and, on
 * success, hands the returned case to `onReinvestigated` and closes. WP03 mounts it in
 * place of the inline copy; WP09 makes it non-blocking (`wait=false`, a `202`, the
 * run's progress on the case header chip) and turns a second request into the
 * `409 investigation_running` notice.
 */
import * as React from 'react';
import { AlertTriangle, LoaderCircle, Play, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import type { Case, ModelsResponse } from '@/lib/types';
import { useAuth } from '@/soc/auth';
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

export interface ReinvestigateDialogProps {
  caseRecord: Case | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The models the picker offers (best effort; `null` offers the configured model only). */
  models: ModelsResponse | null;
  /** The case the run returned (the blocking stub; WP09's body reports through the store). */
  onReinvestigated?: (next: Case) => void;
  /** Where focus returns when the dialog closes (the control that opened it). */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The toast for a reinvestigation that did not start. A refusal (403: the grant is
 * missing, or was removed after the case opened) is worded, never the server's raw
 * "permission denied: cases:reinvestigate"; any other failure keeps its message.
 * (The same wording as `CaseDetail.reinvestigateErrorText`.)
 */
export function reinvestigateErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) return 'You do not have permission to reinvestigate cases.';
  return error instanceof Error && error.message ? error.message : 'The reinvestigation could not be started.';
}

export const ReinvestigateDialog: React.FC<ReinvestigateDialogProps> = ({
  caseRecord,
  open,
  onOpenChange,
  models,
  onReinvestigated,
  onCloseAutoFocus,
}) => {
  const { hasPermission } = useAuth();
  const canViewCost = hasPermission('cost', 'view');
  const [reinvestModel, setReinvestModel] = React.useState('');
  const [reinvesting, setReinvesting] = React.useState(false);
  const caseId = caseRecord?.case_id ?? '';

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
    setReinvesting(true);
    try {
      const input = reinvestModel.trim() ? { model: reinvestModel.trim() } : undefined;
      const next = await api.reinvestigateCase(caseId, input);
      onReinvestigated?.(next);
      onOpenChange(false);
    } catch (e) {
      toast.error(reinvestigateErrorText(e));
    } finally {
      setReinvesting(false);
    }
  }, [caseId, reinvestModel, onReinvestigated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            Re-run the investigation
          </DialogTitle>
          <DialogDescription>
            Force a fresh AI investigation. This runs the LLM pipeline and may take a few
            seconds.
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
            disabled={reinvesting}
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
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={reinvesting}>
            Cancel
          </Button>
          <Button onClick={() => void runReinvestigate()} disabled={reinvesting || !caseId}>
            {reinvesting ? (
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
