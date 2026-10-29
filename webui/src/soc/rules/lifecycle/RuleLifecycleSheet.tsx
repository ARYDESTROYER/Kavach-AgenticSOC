/**
 * RuleLifecycleSheet (Round-5 G6, R5): the per-rule LIFECYCLE surface: test/preview
 * a rule against recent data, walk its immutable version history (diff + rollback), and
 * move it between the enabled and disabled states.
 *
 * ┌─ THE INVARIANTS ────────────────────────────────────────────────────────────┐
 * │ #3  Nothing here calls `decide()` or sets a case status. A lifecycle state      │
 * │     change is a CONFIG write the parent performs via the deep-merge buffer       │
 * │     (`onLifecycleChange`); a rollback is a config write on the RB endpoint.      │
 * │ #6  Preview is a pure read: it never bills the LLM (zero UsageDoc).              │
 * │ #2  Every state change / rollback is append-only audited + versioned server-side.│
 * │ #9  Every rule name / field / summary / log value renders PLAIN text.           │
 * └────────────────────────────────────────────────────────────────────────────────┘
 *
 * "Tune" is the PRIMARY CTA over "Disable" (RESEARCH_RULES_UX §6a: disabling a noisy
 * rule instead of tuning it is the #1 SIEM anti-pattern). Disabling a live rule reduces
 * coverage, so it is a secondary, confirm-gated action; a `request_approval`-style
 * risky change is surfaced as routing to the Approvals/Proposals HITL queue.
 *
 * Round 14 (SPEC §4.9.1, D26): the sheet is titled with the rule's name (the row menu
 * opens it as "Test and history"); its body shares the header's inset; the two sections
 * are underline tabs; the copy has no em dashes.
 *
 * The state control offers Enabled and Disabled only. A rule has one wire flag
 * (`enabled`), so a "shadow" state that evaluates without creating cases cannot be kept
 * or honoured by the pipeline; offering it would switch the rule on while promising the
 * opposite. A real shadow mode needs a wire flag and pipeline support first.
 */
import * as React from 'react';
import { Pencil } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
import { Button } from '@/ui/button';
import { Skeleton } from '@/ui/skeleton';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { HelpTip } from '@/soc/components/HelpTip';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { useReturnFocus } from '@/soc/hooks/useReturnFocus';

import type { RuleForm } from '../types';
import { RuleVersionLedger } from './RuleVersionLedger';
import { LifecycleStateChip, RuleHealthChip, deriveHealth } from './chips';
import type { RuleHealth, RuleKind, RuleLifecycleState, RulePreviewResult } from './types';

/** The states an operator can choose: the rule's one wire flag, on or off. */
export type RuleStateChoice = Extract<RuleLifecycleState, 'enabled' | 'disabled'>;

// The preview panel pulls in recharts (the histogram). Lazy-load it so recharts stays
// OFF the first-paint bundle (the Settings/Detection-rules home is statically
// reachable); the chart JS is only fetched when an operator opens the preview tab.
// A dynamic import here is what the bundle-first-paint guard explicitly allows.
const RulePreviewPanel = React.lazy(() =>
  import('./RulePreviewPanel').then((m) => ({ default: m.RulePreviewPanel })),
);

export interface RuleLifecycleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule being managed (for the preview predicate + display name). */
  rule: RuleForm;
  /** The version-ledger coordinates (family + rule key). */
  kind: RuleKind;
  ruleId: string;
  /** Current lifecycle state (enabled or disabled; the wire has no other state). */
  state: RuleLifecycleState;
  /**
   * RBAC for the LIFECYCLE-STATE control (enabled or disabled). That change is
   * persisted by the parent through the shared Settings buffer (`PUT /api/settings`),
   * which the backend enforces on `settings:manage`, so this gate must reflect the
   * combined `rules:manage` + `settings:manage` capability (M2).
   */
  canManage?: boolean;
  /**
   * RBAC for the version-ledger ROLLBACK. Rollback calls the rules-native endpoint
   * (`POST /api/rules/{kind}/{id}/rollback`), which the backend enforces on `rules:manage`
   * ONLY: it does NOT ride the Settings buffer. Kept SEPARATE so a role with the unified
   * `rules:manage` grant (but not `settings:manage`) can still roll back a rule (M2).
   * Defaults to `canManage` for back-compat when the caller doesn't distinguish them.
   */
  canRollback?: boolean;
  /**
   * A lifecycle state change (enabled or disabled). The PARENT maps this to a
   * deep-merge config write (never `decide()`), so this component stays a pure
   * presenter. Omit to render the controls read-only.
   */
  onLifecycleChange?: (next: RuleStateChoice) => void;
  /** Open the full rule editor to "tune" (the PRIMARY CTA). */
  onTune?: () => void;
  /** Called after a rollback so the parent can refetch the rule config. */
  onRolledBack?: (restoredFrom: string) => void;
  /**
   * The sheet is opened from state (a row menu item), so it has no Radix trigger to hand
   * focus back to. The parent passes its opener-focus handler here so Escape, the close
   * button and "Tune rule" return focus to what opened the sheet (SPEC §3.3).
   */
  onCloseAutoFocus?: (event: Event) => void;
}

export function RuleLifecycleSheet({
  open,
  onOpenChange,
  rule,
  kind,
  ruleId,
  state,
  canManage = false,
  canRollback = canManage,
  onLifecycleChange,
  onTune,
  onRolledBack,
  onCloseAutoFocus,
}: RuleLifecycleSheetProps) {
  // Health is a PURE derivation of the current lifecycle state + the last preview
  // outcome. Keeping the raw preview counts (not the derived RuleHealth) in state means
  // health re-derives whenever `state` changes, so toggling to Disabled immediately
  // re-reads as "Not evaluated" instead of retaining a stale green "Matching" (#30).
  const [lastPreview, setLastPreview] = React.useState<{ matched: number; scanned: number } | null>(null);
  const [previewErrored, setPreviewErrored] = React.useState(false);
  const health = React.useMemo<RuleHealth>(
    () =>
      deriveHealth({
        state,
        lastMatched: lastPreview?.matched ?? null,
        lastScanned: lastPreview?.scanned ?? null,
        lastErrored: previewErrored,
      }),
    [state, lastPreview, previewErrored],
  );

  const onPreviewResult = React.useCallback((res: RulePreviewResult) => {
    setPreviewErrored(false);
    setLastPreview({ matched: res.matched, scanned: res.scanned });
  }, []);
  const onPreviewError = React.useCallback(() => setPreviewErrored(true), []);

  // Disabling a LIVE rule reduces coverage: gate it behind an explicit confirm.
  const [confirmDisable, setConfirmDisable] = React.useState(false);
  // The confirm opens from the state control, not a Radix trigger. When it closes, focus
  // goes back to the state control's checked option, resolved then: "Enabled" after
  // Cancel, "Disabled" once the parent has applied the change (SPEC §3.3).
  const stateControlRef = React.useRef<HTMLDivElement>(null);
  const disableOpener = useReturnFocus();

  const applyState = (next: RuleStateChoice) => {
    if (!onLifecycleChange || next === state) return;
    if (next === 'disabled' && state !== 'disabled') {
      disableOpener.remember(
        () =>
          stateControlRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
          stateControlRef.current?.querySelector<HTMLElement>('[role="radio"]'),
      );
      setConfirmDisable(true);
      return;
    }
    onLifecycleChange(next);
  };

  const displayName = rule.about?.name || ruleId;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="xl" className="flex w-full flex-col" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words">{displayName}</span>
            <LifecycleStateChip state={state} />
            <RuleHealthChip health={health} />
          </SheetTitle>
          <SheetDescription>
            Test this rule against recent data, review its version history and choose its state.
            Everything here writes configuration only. It never changes a case decision.
          </SheetDescription>
        </SheetHeader>

        {/* The sheet body sits on the same inset as the header. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
          {/* Lifecycle control bar: "Tune" is the PRIMARY CTA over "Disable". */}
          <div className="flex flex-wrap items-center gap-2">
            {onTune ? (
              <Button size="sm" onClick={onTune}>
                <Pencil className="h-4 w-4" aria-hidden />
                Tune rule
              </Button>
            ) : null}

            <div ref={stateControlRef} className="flex items-center gap-1.5">
              <SegmentedControl
                size="sm"
                aria-label="Rule state"
                value={state}
                onValueChange={(v) => applyState(v as RuleStateChoice)}
                disabled={!canManage || !onLifecycleChange}
                options={[
                  { value: 'enabled', label: 'Enabled' },
                  { value: 'disabled', label: 'Disabled' },
                ]}
              />
              <HelpTip
                label="About rule states"
                text="Disabling a live rule reduces coverage; prefer tuning it."
              />
            </div>
          </div>

          <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
            <TabsList variant="underline">
              <TabsTrigger value="preview">Test and preview</TabsTrigger>
              <TabsTrigger value="history">Version history</TabsTrigger>
            </TabsList>

            <div className="min-h-0 flex-1 overflow-y-auto pt-3">
              <TabsContent value="preview" className="mt-0">
                <React.Suspense
                  fallback={
                    <div className="space-y-3" aria-busy="true" aria-label="Loading preview">
                      <Skeleton className="h-16 w-full" />
                      <Skeleton className="h-8 w-56" />
                      <Skeleton className="h-40 w-full" />
                    </div>
                  }
                >
                  <RulePreviewPanel rule={rule} onResult={onPreviewResult} onError={onPreviewError} />
                </React.Suspense>
              </TabsContent>
              <TabsContent value="history" className="mt-0">
                <RuleVersionLedger
                  kind={kind}
                  ruleId={ruleId}
                  canManage={canRollback}
                  onRolledBack={onRolledBack}
                />
              </TabsContent>
            </div>
          </Tabs>
        </div>

        <ConfirmDialog
          open={confirmDisable}
          onOpenChange={(o) => {
            if (!o) setConfirmDisable(false);
          }}
          destructive
          returnFocusRef={disableOpener.ref}
          title="Disable this rule?"
          description="Disabling a live rule reduces detection coverage. Consider tuning it instead: a noisy rule is usually better narrowed than turned off. This writes configuration only; it never changes a case."
          confirmLabel="Disable rule"
          onConfirm={() => {
            setConfirmDisable(false);
            onLifecycleChange?.('disabled');
          }}
        >
          <p className="text-sm text-muted-foreground">
            The rule stops producing candidates until you enable it again. The change is recorded
            as a version you can restore.
          </p>
        </ConfirmDialog>
      </SheetContent>
    </Sheet>
  );
}
RuleLifecycleSheet.displayName = 'RuleLifecycleSheet';
