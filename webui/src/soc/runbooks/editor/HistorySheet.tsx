/**
 * The History sheet (Round 14, SPEC §4.10.5, §4.10.12): every version of the runbook with
 * its state and who published it, a step-level comparison between any two versions, and
 * "Restore as draft" (a new draft from that version's text; the live version is untouched).
 *
 * Names and text are plain text (#9). Restoring needs `runbooks:manage` and is unavailable in
 * Demo Mode and on a built-in. While a draft or a version in review exists the server refuses
 * a restore (nobody's work is overwritten), and while the editor holds unsaved changes the
 * restored draft would replace them, so in both cases Restore is offered disabled with the
 * reason beside it.
 */
import * as React from 'react';
import { History, RotateCcw } from 'lucide-react';

import { getRunbookVersion } from '@/lib/api-runbooks';
import type { RunbookDetail, RunbookVersionDoc } from '@/lib/types-runbooks';
import { Button } from '@/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';

import { GovernanceBadge } from '../shared/chips';
import { formatDay } from '../shared/dates';
import { runbookFailure } from '../shared/errors';
import { diffDefinitions, stepChangeLine } from './diff';

export interface HistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: RunbookDetail;
  /** Restore is offered (`runbooks:manage`, not Demo, not a built-in). */
  canRestore: boolean;
  /**
   * Why Restore cannot run now, shown beside the disabled buttons: unsaved edits in the
   * editor, or a draft or version in review that the server would refuse to overwrite.
   */
  restoreBlocked?: string | null;
  /** Called with the version to restore; the editor runs the request. */
  onRestore: (version: number) => Promise<void>;
  /** The control that opened the sheet; focus returns to it when the sheet closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Version documents, read once each. A draft keeps its version number across saves, so a
 * document is cached under the runbook's revision as well: after a save the comparison reads
 * the draft again and never shows its text as it was before.
 */
function useVersionDocs(runbookId: string, revision: number) {
  const cache = React.useRef(new Map<string, RunbookVersionDoc>());
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const [error, setError] = React.useState<string | null>(null);
  const key = React.useCallback((version: number) => `${runbookId}:${revision}:${version}`, [runbookId, revision]);
  const load = React.useCallback(
    async (version: number) => {
      if (cache.current.has(key(version))) return;
      try {
        const doc = await getRunbookVersion(runbookId, version);
        cache.current.set(key(version), doc);
        setError(null);
        force();
      } catch (err) {
        setError(runbookFailure(err, 'Could not read that version.').message);
      }
    },
    [runbookId, key],
  );
  const get = React.useCallback((version: number) => cache.current.get(key(version)) ?? null, [key]);
  return { get, load, error };
}

export function HistorySheet({
  open,
  onOpenChange,
  detail,
  canRestore,
  restoreBlocked = null,
  onRestore,
  returnFocusRef,
}: HistorySheetProps) {
  const versions = [...detail.versions].sort((a, b) => b.version - a.version);
  const newest = versions[0]?.version ?? null;
  const live = detail.summary.live_version;
  const [from, setFrom] = React.useState<number | null>(null);
  const [to, setTo] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<number | null>(null);
  const { get, load, error } = useVersionDocs(detail.summary.id, detail.revision);
  const blockedId = React.useId();
  const working = detail.draft ?? detail.in_review ?? null;
  const blocked =
    restoreBlocked ??
    (working ? `Version ${working.version.toLocaleString()} is still ${working.state === 'in_review' ? 'in review' : 'a draft'}. Discard or publish it first.` : null);

  React.useEffect(() => {
    if (!open) return;
    const right = newest;
    const left = live != null && live !== newest ? live : versions[1]?.version ?? null;
    setTo(right);
    setFrom(left);
    // Only when the sheet opens or the version list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, newest, live, versions.length]);

  React.useEffect(() => {
    if (!open) return;
    if (from != null) void load(from);
    if (to != null) void load(to);
  }, [open, from, to, load]);

  const left = from != null ? get(from) : null;
  const right = to != null ? get(to) : null;
  const diff = left && right ? diffDefinitions(left.definition, right.definition) : null;

  const restore = async (version: number) => {
    setBusy(version);
    try {
      await onRestore(version);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="lg"
        className="overflow-y-auto"
        data-history-sheet=""
        onCloseAutoFocus={
          returnFocusRef
            ? (event) => {
                const target = returnFocusRef.current;
                if (target) {
                  event.preventDefault();
                  target.focus();
                }
              }
            : undefined
        }
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4" aria-hidden />
            History
          </SheetTitle>
          <SheetDescription>
            Every version of {detail.summary.title}. Restoring a version makes a new draft from its text; the live
            version does not change until a new one is published.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 p-6">
          <section aria-label="Versions" className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Versions</h3>
            {canRestore && blocked ? (
              <p id={blockedId} className="text-sm text-muted-foreground" data-restore-blocked="">
                {blocked}
              </p>
            ) : null}
            <ol className="divide-y divide-border/70 rounded-lg border border-border">
              {versions.map((v) => (
                <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5" data-version={v.version}>
                  <span className="font-medium tabular-nums text-foreground">v{v.version.toLocaleString()}</span>
                  <GovernanceBadge state={v.state} />
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {v.published_by
                      ? `Published by ${v.published_by}${v.published_at ? ` on ${formatDay(v.published_at)}` : ''}`
                      : v.state === 'draft'
                        ? 'Not published'
                        : v.state === 'in_review'
                          ? 'Waiting for review'
                          : ''}
                  </span>
                  {canRestore && v.state !== 'draft' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      disabled={busy !== null || !!blocked}
                      aria-describedby={blocked ? blockedId : undefined}
                      onClick={() => void restore(v.version)}
                    >
                      <RotateCcw aria-hidden />
                      {`Restore v${v.version.toLocaleString()} as draft`}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>

          {versions.length > 1 ? (
            <section aria-label="Compare versions" className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Compare</h3>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Select value={from != null ? String(from) : ''} onValueChange={(v) => setFrom(Number(v))}>
                  <SelectTrigger aria-label="Earlier version" className="h-8 w-28">
                    <SelectValue placeholder="Version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.version} value={String(v.version)}>
                        {`v${v.version.toLocaleString()}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">to</span>
                <Select value={to != null ? String(to) : ''} onValueChange={(v) => setTo(Number(v))}>
                  <SelectTrigger aria-label="Later version" className="h-8 w-28">
                    <SelectValue placeholder="Version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.version} value={String(v.version)}>
                        {`v${v.version.toLocaleString()}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-critical-text">
                  {error}
                </p>
              ) : null}
              {left && right ? (
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>{`v${left.version.toLocaleString()} written by ${left.author}${left.published_by ? `, published by ${left.published_by}` : ''}.`}</p>
                  <p>{`v${right.version.toLocaleString()} written by ${right.author}${right.published_by ? `, published by ${right.published_by}` : ''}.`}</p>
                </div>
              ) : null}
              {diff ? (
                diff.same ? (
                  <p className="text-sm text-muted-foreground">These two versions hold the same runbook.</p>
                ) : (
                  <div className="space-y-3" data-version-diff="">
                    {diff.steps.length ? (
                      <div className="space-y-1">
                        <h4 className="text-sm font-medium text-foreground">Steps</h4>
                        <ul className="space-y-1">
                          {diff.steps.map((change, i) => (
                            <li key={`${change.id}-${change.kind}-${i}`} className="text-sm text-foreground [overflow-wrap:anywhere]" data-step-change={change.kind}>
                              {stepChangeLine(change)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {diff.header.length ? (
                      <div className="space-y-1">
                        <h4 className="text-sm font-medium text-foreground">Runbook fields</h4>
                        <dl className="space-y-2">
                          {diff.header.map((change) => (
                            <div key={change.field} className="text-sm">
                              <dt className="font-medium text-foreground">{change.label}</dt>
                              <dd className="text-muted-foreground [overflow-wrap:anywhere]">
                                <span className="line-through decoration-muted-foreground/60">{change.before}</span>
                                <span aria-hidden> → </span>
                                <span className="sr-only"> changed to </span>
                                <span className="text-foreground">{change.after}</span>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ) : null}
                  </div>
                )
              ) : from != null && to != null && !error ? (
                <p className="text-sm text-muted-foreground">Reading both versions.</p>
              ) : null}
            </section>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
