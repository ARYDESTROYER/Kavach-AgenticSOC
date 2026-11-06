/**
 * DetectionRulesHome (Round-5 G6, R2): the "Detection & rules" HOME.
 *
 * This is the Settings section body for `id: 'detection_rules'` (registered under the
 * General group in `settings-sections.ts`). It lists BOTH rule families in one table
 * (detection rules from `Preferences.rule_catalog` and case-automation rules from
 * `Preferences.threshold_automation.rules`) and opens the four-section `RuleEditor`
 * (Define, About, Schedule, Actions) in a Sheet.
 *
 * Round 14 (SPEC §4.9.4, uib DR1 to DR5, F11): no explanation box above the table (the
 * section's help tip says that a rule never sets a case status); the rules sit in one
 * compact table on a group panel with sentence-case headers; a row opens its editor on
 * click (the name is the keyboard control); "Test and history" and "Delete rule" live in
 * the row menu, neutral at rest and red only on intent. Closing the rule editor or the
 * "Test and history" sheet hands focus back to what opened it (the rule's name, or the
 * row's menu button; SPEC §3.3). A case-automation rule that
 * attaches a runbook which is not published (unknown, a draft only or retired) shows
 * "Needs a runbook", resolved by the same rule the server uses at fire time
 * (`@/soc/runbooks/shared/legacy`), so the operator sees the skip before it happens.
 *
 * CONFIG WRITER ONLY (#3): every edit flows form, `./adapter`, the deep-merge
 * `{prefs, update}` buffer the Settings page owns (which PUTs `/api/settings`). No
 * control here calls `decide()` or sets a case status. Mutations are RBAC-gated on the
 * unified `rules:manage` grant plus `settings:manage` (R9, M2); a read-only viewer still
 * SEES the catalog and can open the editor read-only. #9: every rule name and field
 * renders as plain text.
 */
import * as React from 'react';
import { History, Plus, Trash2, Workflow } from 'lucide-react';

import type { Preferences } from '@/lib/types';
import type { RunbookLibrary, RunbookSummary } from '@/lib/types-runbooks';
import { listRunbookLibrary } from '@/lib/api-runbooks';
import { cn } from '@/lib/cn';

import { Callout } from '@/design-system/callout';
import { RowActions, type RowAction } from '@/design-system/row-actions';
import { StatusDot, type StatusTone } from '@/design-system/status-dot';
import { useCan } from '@/soc/components/Can';
import { useIsMobile } from '@/soc/hooks/useMediaQuery';
import { useReturnFocus } from '@/soc/hooks/useReturnFocus';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { SettingsGroup } from '@/soc/pages/settings/primitives';
import { resolveAutomationRunbook } from '@/soc/runbooks/shared/legacy';
import { Button } from '@/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/ui/sheet';

import { RuleEditor } from './RuleEditor';
import type { AutomationRule, RuleCatalogItem, RuleForm, RuleTier } from './types';
import { RULES_PERM, RULES_READ_PERM } from './types';
import { newRuleForm } from './constants';
import {
  anomalyToBaseline,
  baselineToAnomaly,
  caseAutomationToWire,
  detectionMatchToWire,
  wireToCaseAutomation,
  wireToDetectionMatch,
} from './adapter';
// Import from the specific lifecycle submodules (NOT the barrel) so the recharts-heavy
// `RulePreviewPanel` (which the barrel re-exports) is not statically pulled into the
// eager Settings/Detection-rules entry graph. The sheet lazy-loads that panel itself.
import { RuleLifecycleSheet, type RuleStateChoice } from './lifecycle/RuleLifecycleSheet';
import type { RuleKind, RuleLifecycleState } from './lifecycle/types';

export interface DetectionRulesHomeProps {
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
}

/** A stable id for a freshly-created case-automation rule. */
let _autoSeq = 0;
function newAutomationId(): string {
  _autoSeq += 1;
  return `rule-${Date.now().toString(36)}-${_autoSeq}`;
}

/**
 * Derive a NEW case-automation rule's id from the operator's typed Name so the required
 * Name field is not silently discarded and shown back as an opaque machine id (#25). The
 * wire `CaseAutomationRule` is keyed only by `id`, so the id doubles as the display name.
 * Empty → auto-generate; a collision with an existing id gets a numeric suffix.
 */
export function automationIdFromName(name: string, existing: readonly AutomationRule[]): string {
  const base = name.trim();
  if (!base) return newAutomationId();
  const taken = new Set(existing.map((r) => r.id));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return newAutomationId();
}

/** Build the merged catalog table rows from both wire sources. Each row carries its
 * source-array INDEX so edit/delete/toggle target exactly that row even when two rules
 * share a display name/id (#24). */
function buildCatalog(prefs: Preferences): RuleCatalogItem[] {
  const detection: RuleCatalogItem[] = (prefs.rule_catalog ?? []).map((r, i) => ({
    key: `det:${i}`,
    sourceIndex: i,
    tier: 'detection_match',
    name: r.name,
    enabled: r.enabled ?? true,
    priority: typeof r.priority === 'number' ? r.priority : 100,
    lifecycle: (r.enabled ?? true) ? 'enabled' : 'disabled',
  }));
  const automation: RuleCatalogItem[] = (prefs.threshold_automation?.rules ?? []).map((r, i) => ({
    key: `auto:${i}`,
    sourceIndex: i,
    tier: 'case_automation',
    name: r.id,
    enabled: r.enabled ?? true,
    priority: typeof r.priority === 'number' ? r.priority : 100,
    lifecycle: (r.enabled ?? true) ? 'enabled' : 'disabled',
  }));
  return [...detection, ...automation].sort((a, b) => a.priority - b.priority);
}

/**
 * The rule family in the table's Type column: short words that fit one line (the editor's
 * type select keeps the longer descriptive labels of `RULE_TIER_BY_ID` in `./constants`).
 */
const TYPE_LABEL: Record<RuleTier, string> = {
  detection_match: 'Match and threshold',
  detection_anomaly: 'Anomaly baseline',
  case_automation: 'Case automation',
};

/**
 * A rule's state in the table: a quiet dot and its word. A rule has one wire flag, so it
 * is Enabled or Disabled, both the operator's settled choices (neutral). The words match
 * the lifecycle sheet's state control.
 */
const STATE_DOT: Record<RuleStateChoice, { tone: StatusTone; label: string }> = {
  enabled: { tone: 'neutral', label: 'Enabled' },
  disabled: { tone: 'neutral', label: 'Disabled' },
};

function stateOf(item: RuleCatalogItem): RuleStateChoice {
  return item.lifecycle === 'disabled' ? 'disabled' : 'enabled';
}

/** The rule's name button in the table, the row's keyboard control. */
function ruleNameButton(root: HTMLElement | null, key: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-rule-name-key="${key}"]`) ?? null;
}

/**
 * The case-automation rules that attach a runbook the server would skip at fire time
 * (unknown, a draft only or retired), keyed by catalog row. `library` null means the
 * library could not be read (or the viewer cannot read runbooks): nothing is flagged
 * then, except a rule that names no runbook at all, which can never attach one.
 */
export function rulesNeedingRunbook(
  prefs: Preferences,
  library: readonly RunbookSummary[] | null,
  migratedProcedures?: Readonly<Record<string, string>> | null,
): Set<string> {
  const keys = new Set<string>();
  (prefs.threshold_automation?.rules ?? []).forEach((rule, i) => {
    if (rule.action !== 'run_playbook') return;
    if (resolveAutomationRunbook(rule.payload ?? {}, library, migratedProcedures).status === 'needs_runbook') {
      keys.add(`auto:${i}`);
    }
  });
  return keys;
}

/** A single edit session's target (which wire list + index the form maps back to). */
type EditTarget =
  | { kind: 'new' }
  | { kind: 'detection'; index: number }
  | { kind: 'automation'; index: number };

export function DetectionRulesHome({ prefs, update }: DetectionRulesHomeProps) {
  // The unified `rules` grant (G6 R9 / M2) gates the rules-native actions (the version
  // ledger, one-click rollback, and the read-only preview all call `routes_rules.py`),
  // which enforces `rules:read`/`rules:manage`. This surface is REACHED via the `rules`
  // section gate (`settings-sections-meta.ts`, now `rules:read`).
  const canManageRules = useCan(RULES_PERM.resource, RULES_PERM.action);
  // M2 write-path reality: this Settings SECTION persists edits through the shared
  // Settings buffer (a deep-merge `PUT /api/settings`), which the backend enforces on
  // `settings:manage`, NOT the rules-native CRUD endpoints. So a WRITE here needs BOTH
  // the unified `rules:manage` grant AND `settings:manage`. Gating the write affordances
  // on both means a custom role missing either never sees an enabled Save/Delete that
  // would then 403. For every BUILT-IN role `rules`/`settings` derive identically from
  // `settings` (`rbac/policy._settings_like`), so this is behaviour-preserving for them.
  const canWriteSettings = useCan('settings', 'manage');
  const canManage = canManageRules && canWriteSettings;
  // `useCan` returns true when auth/RBAC is off (back-compat), so read is implicit.
  void RULES_READ_PERM;

  const catalog = React.useMemo(() => buildCatalog(prefs), [prefs]);
  // Phone layout of the rules table (name and state stacked, row menu); see `columns`.
  const compact = useIsMobile();

  // "Needs a runbook": read the runbook library only when a case-automation rule attaches
  // one and the viewer may read runbooks. A failed read flags nothing (no false warning).
  const canReadRunbooks = useCan('runbooks', 'read');
  const attachesRunbook = (prefs.threshold_automation?.rules ?? []).some((r) => r.action === 'run_playbook');
  const [runbookLibrary, setRunbookLibrary] = React.useState<RunbookLibrary | null>(null);
  React.useEffect(() => {
    if (!attachesRunbook || !canReadRunbooks) return undefined;
    const controller = new AbortController();
    listRunbookLibrary({ show_replaced: true }, controller.signal)
      .then((lib) => setRunbookLibrary(lib))
      .catch(() => {
        if (!controller.signal.aborted) setRunbookLibrary(null);
      });
    return () => controller.abort();
  }, [attachesRunbook, canReadRunbooks]);
  const needsRunbook = React.useMemo(
    () =>
      canReadRunbooks && runbookLibrary
        ? rulesNeedingRunbook(prefs, runbookLibrary.runbooks, runbookLibrary.migrated_procedures)
        : rulesNeedingRunbook(prefs, null),
    [prefs, canReadRunbooks, runbookLibrary],
  );

  // Each sheet and the delete dialog is opened from state (no Radix trigger), so each
  // remembers what opened it and hands focus back there on close (SPEC §3.3).
  const rootRef = React.useRef<HTMLDivElement>(null);
  const editorOpener = useReturnFocus();
  const lifecycleOpener = useReturnFocus();
  const deleteOpener = useReturnFocus();

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<RuleForm | null>(null);
  const [target, setTarget] = React.useState<EditTarget | null>(null);
  // A validation message surfaced when Save is rejected (e.g. a nameless / condition-less
  // detection rule) so the operator is never left with a silent, dead Save button.
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // A rule pending a delete confirmation. Destructive deletes are gated (parity with the
  // confirm-gated Disable in the lifecycle sheet), so a single misclick can't wipe a rule.
  const [confirmDelete, setConfirmDelete] = React.useState<RuleCatalogItem | null>(null);

  // The per-rule lifecycle surface (test/preview + version ledger + state). It maps a
  // catalog item to the {kind, ruleId, form, state} the RuleLifecycleSheet needs. A
  // lifecycle STATE change is a config write through the same deep-merge `update`
  // buffer, never `decide()`; a rollback is a config write on the RB endpoint.
  const [lifecycle, setLifecycle] = React.useState<{
    kind: RuleKind;
    ruleId: string;
    form: RuleForm;
    state: RuleLifecycleState;
    item: RuleCatalogItem;
  } | null>(null);

  const startNew = () => {
    editorOpener.remember();
    setSaveError(null);
    setDraft(newRuleForm('detection_match'));
    setTarget({ kind: 'new' });
    setOpen(true);
  };

  const startEdit = (item: RuleCatalogItem, opener?: HTMLElement | null) => {
    // Focus returns to the rule's name (the row's keyboard control) unless a caller hands
    // over another opener ("Tune rule" from the lifecycle sheet passes the row's menu).
    editorOpener.remember(opener ?? (() => ruleNameButton(rootRef.current, item.key)));
    setSaveError(null);
    // Identify the rule by its source-array INDEX (never a name/id match), so editing one
    // of two same-named rules resolves to exactly the row clicked (#24).
    if (item.tier === 'case_automation') {
      const rule = (prefs.threshold_automation?.rules ?? [])[item.sourceIndex];
      if (!rule) return;
      setDraft(wireToCaseAutomation(rule));
      setTarget({ kind: 'automation', index: item.sourceIndex });
    } else {
      const def = (prefs.rule_catalog ?? [])[item.sourceIndex];
      if (!def) return;
      setDraft(wireToDetectionMatch(def));
      setTarget({ kind: 'detection', index: item.sourceIndex });
    }
    setOpen(true);
  };

  /** Switch a brand-new rule's tier (only allowed before first save). The anomaly tier
   * edits the shared org baseline block, so seed its form from the CURRENT baseline so
   * the operator sees (and tunes) the real values rather than blank defaults. */
  const changeTier = (tier: RuleTier) => {
    setSaveError(null);
    setDraft((cur) => {
      const base = tier === 'detection_anomaly' ? baselineToAnomaly(prefs.baseline) : newRuleForm(tier);
      const carried = cur?.about;
      if (!carried) return base;
      // Carry only normal, editable About metadata across a new-rule tier switch.
      return {
        ...base,
        about: {
          ...base.about,
          name: carried.name,
          description: carried.description,
          priority: carried.priority,
        },
      } as RuleForm;
    });
  };

  /**
   * Open the per-rule LIFECYCLE surface (test/preview + version history + state). Maps
   * the catalog item to the form + ledger coordinates. The version-ledger `kind` uses
   * the backend rule-family vocabulary (`detection`/`case_automation`), distinct from
   * the UI `RuleTier`. Anomaly rules have no per-rule catalog entry to version, so the
   * lifecycle surface is offered for detection + case-automation rules only.
   */
  const openLifecycle = (item: RuleCatalogItem) => {
    // Opened from the row menu: the item leaves with the menu, so focus returns to the
    // row's menu button.
    lifecycleOpener.remember();
    // Resolve the exact rule by index (#24). `ruleId` stays the wire identity
    // (detection: name; automation: id) the backend version ledger keys on.
    if (item.tier === 'case_automation') {
      const rule = (prefs.threshold_automation?.rules ?? [])[item.sourceIndex];
      if (!rule) return;
      setLifecycle({
        kind: 'case_automation',
        ruleId: rule.id,
        form: wireToCaseAutomation(rule),
        state: item.lifecycle,
        item,
      });
    } else {
      const def = (prefs.rule_catalog ?? [])[item.sourceIndex];
      if (!def) return;
      setLifecycle({
        kind: 'detection',
        ruleId: def.name,
        form: wireToDetectionMatch(def),
        state: item.lifecycle,
        item,
      });
    }
  };

  /**
   * Apply a lifecycle STATE change as a CONFIG write through the deep-merge `update`
   * buffer, never `decide()`. `enabled` and `disabled` flip the wire `enabled` flag, the
   * rule's only state. This NEVER sets a case status (#3).
   */
  const setLifecycleState = (item: RuleCatalogItem, next: RuleStateChoice) => {
    const enabled = next === 'enabled';
    // Toggle exactly the indexed row (#24), never every rule that happens to share a name.
    if (item.tier === 'case_automation') {
      const rules = (prefs.threshold_automation?.rules ?? []).map((r, i) =>
        i === item.sourceIndex ? { ...r, enabled } : r,
      );
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else {
      const catalogList = (prefs.rule_catalog ?? []).map((r, i) =>
        i === item.sourceIndex ? { ...r, enabled } : r,
      );
      update({ rule_catalog: catalogList });
    }
    // Reflect the new state in the open lifecycle surface immediately.
    setLifecycle((cur) => (cur && cur.item.key === item.key ? { ...cur, state: next } : cur));
  };

  /** Deterministically map the draft form → wire and deep-merge it in. */
  const save = () => {
    if (!draft) return;
    setSaveError(null);
    if (draft.tier === 'case_automation') {
      const rules = [...(prefs.threshold_automation?.rules ?? [])];
      // Keep an EXISTING rule's stable id on edit; for a NEW rule derive the id from the
      // typed Name so the operator's input persists + shows in the list (#25).
      const id =
        target && target.kind === 'automation' && rules[target.index]
          ? rules[target.index].id
          : automationIdFromName(draft.about.name, rules);
      const wire = caseAutomationToWire(draft, id);
      if (target && target.kind === 'automation') rules[target.index] = wire;
      else rules.push(wire);
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else if (draft.tier === 'detection_match') {
      const wire = detectionMatchToWire(draft);
      if (!wire) {
        // Surface WHY the save is a no-op instead of a silent dead button (#3-safe:
        // this only validates the form; it never calls decide()).
        setSaveError('Give the rule a name (About tab) and at least one condition with a field (Define tab) before saving.');
        return; // keep the sheet open so the operator can fix it
      }
      const catalogList = [...(prefs.rule_catalog ?? [])];
      if (target && target.kind === 'detection') catalogList[target.index] = wire;
      else catalogList.push(wire);
      update({ rule_catalog: catalogList });
    } else if (draft.tier === 'detection_anomaly') {
      // Anomaly rules configure the shared org baseline block (there is no per-rule
      // baseline on the wire yet). Persist it through the same deep-merge buffer so the
      // operator's tuning is actually saved rather than silently discarded on close.
      update({ baseline: anomalyToBaseline(draft, prefs.baseline) });
    }
    setOpen(false);
    setDraft(null);
    setTarget(null);
  };

  const removeItem = (item: RuleCatalogItem) => {
    // Delete exactly the indexed row (#24): a name filter would wipe BOTH rules that
    // share a duplicate name.
    if (item.tier === 'case_automation') {
      const rules = (prefs.threshold_automation?.rules ?? []).filter((_, i) => i !== item.sourceIndex);
      update({ threshold_automation: { ...(prefs.threshold_automation ?? {}), rules } });
    } else {
      const catalogList = (prefs.rule_catalog ?? []).filter((_, i) => i !== item.sourceIndex);
      update({ rule_catalog: catalogList });
    }
  };

  const ruleLabel = (item: RuleCatalogItem) => item.name || 'rule';

  const rowActions = (item: RuleCatalogItem): RowAction[] => {
    const actions: RowAction[] = [];
    // Anomaly rules have no per-rule catalog entry to version, so no lifecycle surface.
    if (item.tier !== 'detection_anomaly') {
      actions.push({ id: 'lifecycle', label: 'Test and history', icon: History, onSelect: () => openLifecycle(item) });
    }
    if (canManage) {
      actions.push({
        id: 'delete',
        label: 'Delete rule',
        icon: Trash2,
        destructive: true,
        onSelect: () => {
          deleteOpener.remember();
          setConfirmDelete(item);
        },
      });
    }
    return actions;
  };

  /** The rule's state, plus "Needs a runbook" when its attach target would be skipped. */
  const stateCell = (item: RuleCatalogItem) => {
    const state = STATE_DOT[stateOf(item)];
    return (
      <span className="flex min-w-0 flex-col items-start gap-1">
        <StatusDot tone={state.tone}>{state.label}</StatusDot>
        {needsRunbook.has(item.key) ? <StatusDot tone="warning">Needs a runbook</StatusDot> : null}
      </span>
    );
  };

  const nameColumn: DataTableColumn<RuleCatalogItem> = {
    id: 'name',
    header: 'Name',
    minWidth: '10rem',
    text: (item) => item.name || '(unnamed)',
    // The name is the row's keyboard control; a click anywhere else on the row opens the
    // same editor (DataTable `onRowClick`). On a phone the state sits under the name.
    cell: (item) => (
      <span className="block min-w-0">
        <button
          type="button"
          data-rule-name-key={item.key}
          onClick={() => startEdit(item)}
          className={cn(
            'block max-w-full truncate rounded-sm text-left font-medium text-foreground hover:underline',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
          )}
        >
          {item.name || <span className="italic text-muted-foreground">(unnamed)</span>}
        </button>
        {compact ? <span className="mt-1 block">{stateCell(item)}</span> : null}
      </span>
    ),
    wrap: compact,
  };
  const actionsColumn: DataTableColumn<RuleCatalogItem> = {
    id: 'actions',
    header: <span className="sr-only">Actions</span>,
    menuLabel: 'Actions',
    // 44px row targets on a phone, 32px from 640px (RowActions), plus the cell inset.
    width: compact ? '4.5rem' : '4rem',
    align: 'right',
    cell: (item) => <RowActions actions={rowActions(item)} inline={0} subject={ruleLabel(item)} />,
  };
  // Below 768px only the name (with its state under it) and the row menu fit; the type
  // and priority are in the editor. A fixed table counts every declared width, so the
  // phone layout drops those columns rather than hiding them with CSS.
  const columns: DataTableColumn<RuleCatalogItem>[] = compact
    ? [nameColumn, actionsColumn]
    : [
        nameColumn,
        {
          id: 'type',
          header: 'Type',
          width: '11rem',
          className: 'text-muted-foreground',
          cell: (item) => TYPE_LABEL[item.tier],
        },
        {
          id: 'state',
          header: 'State',
          width: '10rem',
          wrap: true,
          text: (item) => {
            const state = STATE_DOT[stateOf(item)].label;
            return needsRunbook.has(item.key) ? `${state}, needs a runbook` : state;
          },
          cell: stateCell,
        },
        {
          id: 'priority',
          header: 'Priority',
          kind: 'number',
          align: 'left',
          width: '5.5rem',
          className: 'text-muted-foreground',
          cell: (item) => item.priority,
        },
        actionsColumn,
      ];

  const needsRunbookCount = catalog.filter((item) => needsRunbook.has(item.key)).length;
  const caption =
    catalog.length === 0
      ? undefined
      : [
          `${catalog.length} ${catalog.length === 1 ? 'rule' : 'rules'}, lower priority numbers run first`,
          needsRunbookCount
            ? `${needsRunbookCount} ${needsRunbookCount === 1 ? 'needs' : 'need'} a runbook`
            : null,
        ]
          .filter(Boolean)
          .join('. ');

  return (
    <div ref={rootRef} className="space-y-4">
      <SettingsGroup
        title="Rules"
        caption={caption}
        action={
          canManage ? (
            <Button size="sm" onClick={startNew}>
              <Plus aria-hidden />
              New rule
            </Button>
          ) : undefined
        }
      >
        <DataTable<RuleCatalogItem>
          ariaLabel="Detection and case automation rules"
          columns={columns}
          rows={catalog}
          getRowId={(item) => item.key}
          surface="panel"
          onRowClick={(item) => startEdit(item)}
          showRowAction={false}
          emptyState={
            <EmptyState
              icon={Workflow}
              compact
              title="No rules yet"
              description="Create a detection rule to group events into cases, or a case automation rule to react after triage."
              action={
                canManage ? (
                  <Button size="sm" onClick={startNew}>
                    <Plus aria-hidden />
                    New rule
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </SettingsGroup>

      <Sheet
        open={open}
        onOpenChange={(v) => (v ? setOpen(true) : (setOpen(false), setDraft(null), setSaveError(null)))}
      >
        <SheetContent
          side="right"
          size="lg"
          className={cn('flex w-full flex-col sm:max-w-2xl')}
          onCloseAutoFocus={editorOpener.onCloseAutoFocus}
        >
          <SheetHeader>
            <SheetTitle>
              {target?.kind === 'new' ? 'New rule' : 'Edit rule'}
            </SheetTitle>
            <SheetDescription>
              Configure the rule across Define, About, Schedule, and Actions. Saving writes
              configuration only. It never changes a case decision.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {draft ? (
              <RuleEditor
                value={draft}
                onChange={(next) => {
                  setSaveError(null);
                  setDraft(next);
                }}
                readOnly={!canManage}
                allowTierChange={target?.kind === 'new'}
                onTierChange={changeTier}
              />
            ) : null}
          </div>

          {saveError ? (
            <Callout intent="error" title="Can't save yet" className="mx-6">
              {saveError}
            </Callout>
          ) : null}

          <SheetFooter>
            <Button variant="outline" onClick={() => (setOpen(false), setDraft(null), setSaveError(null))}>
              Cancel
            </Button>
            {canManage ? <Button onClick={save}>Save rule</Button> : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Destructive-delete gate: parity with the confirm-gated Disable in the lifecycle
          sheet. Config writer only (#3): the confirmed delete flows through `update`. */}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
        destructive
        returnFocusRef={deleteOpener.ref}
        title="Delete this rule?"
        description={
          confirmDelete
            ? `"${confirmDelete.name || 'This rule'}" will be removed from your configuration. This writes configuration only. It never changes a case.`
            : ''
        }
        confirmLabel="Delete rule"
        onConfirm={() => {
          if (confirmDelete) removeItem(confirmDelete);
          setConfirmDelete(null);
        }}
      />

      {/* Per-rule LIFECYCLE surface: test/preview, version ledger, rollback and state.
          Config writer only (#3): a state change flows through `update`; a rollback is a
          config write on the RB endpoint. Never `decide()`, never bills the LLM (#6). */}
      {lifecycle ? (
        <RuleLifecycleSheet
          open
          onOpenChange={(o) => {
            if (!o) setLifecycle(null);
          }}
          rule={lifecycle.form}
          kind={lifecycle.kind}
          ruleId={lifecycle.ruleId}
          state={lifecycle.state}
          // Lifecycle-STATE changes ride the Settings buffer (→ `settings:manage`), so
          // they gate on the combined `canManage`. ROLLBACK hits the rules-native
          // endpoint (`rules:manage` only), so it gates on `canManageRules` alone (M2).
          canManage={canManage}
          canRollback={canManageRules}
          onLifecycleChange={canManage ? (next) => setLifecycleState(lifecycle.item, next) : undefined}
          onCloseAutoFocus={lifecycleOpener.onCloseAutoFocus}
          onTune={() => {
            const item = lifecycle.item;
            // The editor takes over the lifecycle sheet's opener (the row's menu button);
            // the closing lifecycle sheet then leaves focus to the editor.
            const opener = lifecycleOpener.ref.current;
            lifecycleOpener.remember(null);
            setLifecycle(null);
            startEdit(item, opener);
          }}
        />
      ) : null}
    </div>
  );
}
DetectionRulesHome.displayName = 'DetectionRulesHome';
