/**
 * RuleVersionLedger (Round-5 G6, R5): the immutable per-rule VERSION history,
 * red/green inline diff + one-click rollback.
 *
 * ┌─ WHAT IT DOES ──────────────────────────────────────────────────────────────┐
 * │ - Lists every recorded version of ONE rule, NEWEST first (author + when + why).│
 * │ - Selecting a version shows a red/green FIELD DIFF vs the current (newest)      │
 * │   config, computed dep-free (`diffConfigs`, NO diff library).                   │
 * │ - "Restore this version" rolls the rule back via the RB rollback endpoint: a   │
 * │   deep-merge config write that APPENDS a `rollback` version (history is         │
 * │   append-only, #2) and NEVER calls `decide()` (#3). Gated by a ConfirmDialog.   │
 * └────────────────────────────────────────────────────────────────────────────────┘
 *
 * Bug #12: each row renders its REAL state: the NEWEST version is the live baseline
 * ("Current"), a version produced by a rollback is tagged, and older versions are
 * "Superseded". Never a hardcoded "Active" on every row.
 *
 * Every id / actor / summary / config value is operator-authored, log-adjacent data →
 * renders PLAIN text (#9). Rollback is gated on the caller's `canManage` grant (RBAC).
 *
 * Round 14 (SPEC §4.9.1): versions are rows divided by hairlines, not bordered cards;
 * each row's state is a `StatusDot` (Current in green, a rollback in blue, Superseded
 * quiet); the diff heading is sentence case.
 */
import * as React from 'react';
import { History, RotateCcw } from 'lucide-react';

import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { StatusDot, type StatusTone } from '@/design-system/status-dot';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { useAsync } from '@/soc/hooks/useAsync';
import { useReturnFocus } from '@/soc/hooks/useReturnFocus';
import { cn } from '@/lib/cn';

import { listRuleVersions, rollbackRule } from '../api';
import { DiffView } from './DiffView';
import type { RuleKind, RuleVersion } from './types';

export interface RuleVersionLedgerProps {
  kind: RuleKind;
  ruleId: string;
  /** RBAC: only a manager may roll back. Read-only viewers see history but no restore. */
  canManage?: boolean;
  /** Called after a successful rollback so the parent can refetch the rule config. */
  onRolledBack?: (restoredFrom: string) => void;
}

/** Humanize the version `action` for a plain-text chip. */
const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Edited',
  enable: 'Enabled',
  disable: 'Disabled',
  delete: 'Deleted',
  rollback: 'Rolled back',
};

/** A compact, locale-agnostic timestamp (UTC) for the row meta. */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  return d.toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}

export function RuleVersionLedger({
  kind,
  ruleId,
  canManage = false,
  onRolledBack,
}: RuleVersionLedgerProps) {
  const { data, loading, error, reload } = useAsync(
    () => listRuleVersions(kind, ruleId),
    [kind, ruleId],
  );
  // Memoize the list so it is a stable reference across renders (keeps the derived
  // `selected` useMemo honest; the ledger returns newest-first).
  const versions: RuleVersion[] = React.useMemo(() => data?.versions ?? [], [data]);

  // The current baseline = the newest version.
  const current = versions[0] ?? null;

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = React.useMemo(
    () => versions.find((v) => v.id === selectedId) ?? null,
    [versions, selectedId],
  );

  const [confirmVersion, setConfirmVersion] = React.useState<RuleVersion | null>(null);
  // The restore confirm opens from a row's Restore button, not a Radix trigger: focus goes
  // back to that button when it closes. The row is keyed by version id, so its button is
  // still there after a restore reloads the list; a version the list no longer has falls
  // back to the list itself (SPEC §3.3).
  const restoreOpener = useReturnFocus();
  const listRef = React.useRef<HTMLOListElement>(null);
  const [rolling, setRolling] = React.useState(false);
  const [rollbackError, setRollbackError] = React.useState<unknown>(null);

  const doRollback = React.useCallback(
    async (version: RuleVersion) => {
      setRolling(true);
      setRollbackError(null);
      try {
        const res = await rollbackRule(kind, ruleId, version.id);
        setConfirmVersion(null);
        setSelectedId(null);
        await reload();
        onRolledBack?.(res.restored_from);
      } catch (e) {
        setRollbackError(e);
      } finally {
        setRolling(false);
      }
    },
    [kind, ruleId, reload, onRolledBack],
  );

  if (loading && versions.length === 0) {
    // Skeleton rows (matching the version-row shape) reserve layout space and match the
    // shared loading grammar, instead of a plain-text loader that jumps on load (#44).
    return (
      <ol className="divide-y divide-border/70" aria-busy="true" aria-label="Loading version history">
        {[0, 1, 2].map((i) => (
          <li key={i} className="py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="ml-auto h-3 w-32" />
            </div>
            <Skeleton className="mt-2 h-3 w-40" />
            <Skeleton className="mt-2 h-8 w-28" />
          </li>
        ))}
      </ol>
    );
  }
  if (error && versions.length === 0) {
    return <LoadError error={error} title="Couldn't load version history" onRetry={reload} />;
  }
  if (versions.length === 0) {
    return (
      <EmptyState
        icon={History}
        compact
        title="No version history yet"
        description="Every create, edit, enable, disable and rollback of this rule is recorded here as a version you can compare and restore."
      />
    );
  }

  return (
    <div className="space-y-3">
      {rollbackError ? (
        <LoadError
          error={rollbackError}
          title="Rollback failed"
          fallback="Could not restore that version."
        />
      ) : null}

      <ol ref={listRef} className="divide-y divide-border/70" data-testid="rule-version-ledger">
        {versions.map((v, idx) => {
          const isCurrent = current !== null && v.id === current.id;
          const isSelected = v.id === selectedId;
          const stateLabel = isCurrent
            ? 'Current'
            : v.action === 'rollback'
              ? 'Rollback'
              : 'Superseded';
          const stateTone: StatusTone = isCurrent
            ? 'success'
            : v.action === 'rollback'
              ? 'info'
              : 'neutral';
          return (
            <li
              key={v.id}
              className={cn(
                '-mx-3 rounded-md px-3 py-3 transition-colors',
                isSelected && 'bg-muted/50',
              )}
              data-testid={`rule-version-${v.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone={stateTone}>{stateLabel}</StatusDot>
                <span className="text-sm font-medium text-foreground">
                  {ACTION_LABEL[v.action] ?? v.action}
                </span>
                {v.rolled_back_to ? (
                  <span className="text-sm text-muted-foreground">
                    restored {v.rolled_back_to}
                  </span>
                ) : null}
                <span className="ml-auto whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                  {whenLabel(v.created_at)}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {v.actor ? <span>by {v.actor}</span> : <span>by system</span>}
                {v.summary ? <span className="break-words">{v.summary}</span> : null}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedId(isSelected ? null : v.id)}
                  aria-expanded={isSelected}
                >
                  {isSelected ? 'Hide changes' : 'Compare with current'}
                </Button>
                {canManage && !isCurrent ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(event) => {
                      if (rolling) return;
                      restoreOpener.remember(event.currentTarget, {
                        empty: () => listRef.current,
                      });
                      setConfirmVersion(v);
                    }}
                    // Busy, not disabled, while a restore runs: the confirm closes at once
                    // and hands focus back to this button, which a disabled button refuses.
                    aria-disabled={rolling || undefined}
                    className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    Restore this version
                  </Button>
                ) : null}
                {idx === 0 ? (
                  <span className="text-sm text-muted-foreground">This is the live configuration.</span>
                ) : null}
              </div>

              {isSelected ? (
                <div className="mt-3 border-t border-border/70 pt-3">
                  <p className="mb-1 text-sm font-medium text-foreground">
                    What restoring this version changes
                  </p>
                  {/* Direction matches the RESTORE action (#42): restoring makes the live
                      config become THIS version, so `before` = current, `after` = v. Now a
                      green "+" is what Restore ADDS and a red "−" is what it REMOVES. */}
                  <DiffView before={current?.config} after={v.config} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <ConfirmDialog
        open={confirmVersion !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmVersion(null);
        }}
        returnFocusRef={restoreOpener.ref}
        title="Restore this version?"
        description={
          selected || confirmVersion
            ? `This replaces the live rule config with the ${ACTION_LABEL[
                (confirmVersion?.action ?? '') as string
              ]?.toLowerCase() ?? 'selected'} version from ${
                confirmVersion ? whenLabel(confirmVersion.created_at) : ''
              }. It writes configuration only. It never changes a case decision, and it is recorded as a new version you can undo.`
            : undefined
        }
        confirmLabel={rolling ? 'Restoring' : 'Restore'}
        onConfirm={() => {
          if (confirmVersion) void doRollback(confirmVersion);
        }}
      />
    </div>
  );
}
RuleVersionLedger.displayName = 'RuleVersionLedger';
