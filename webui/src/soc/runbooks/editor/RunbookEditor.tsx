/**
 * The runbook editor (Round 14, SPEC §4.10.12, C11 A): `#/runbooks?id=<id>` and
 * `#/runbooks?id=new`. A header with the governance strip and the actions of the runbook's
 * state, Applies when as chips, then three views of the same runbook: Edit (an outline of
 * phases and steps, and the selected step's form), Preview as analyst and Source (the
 * Markdown). "Which cases would this match?" is a side column from 1680px and a sheet below.
 *
 * Writes go through the runbook API with `expected_revision`; Publish also sends the
 * reviewed version's `content_hash`, so what is published is exactly what was reviewed.
 * The server is the authority on every rule: live validation shows its issues beside their
 * fields and in a summary under the outline (a new runbook shows an issue only once its
 * field was left or a save was tried, and its summary only after a save was tried, F17); an
 * issue found on text that has since changed is not shown. A save conflict keeps the local
 * edit in the Source view until the person reloads. Built-ins, Demo Mode and viewers without
 * `runbooks:manage` read only.
 *
 * Edits never get lost under a write: a response replaces the working copy only when the
 * person did not change it while the request ran, and the actions that would replace unsaved
 * edits (Mark reviewed, Retire, Send back, Restore a version) wait until they are saved.
 * Focus follows each outcome: to the problems after a refused save, to Reload after a
 * conflict, to the heading when the control that was used is gone, and every sheet and
 * dialog gives focus back to the control that opened it.
 *
 * Every stored value (titles, names, case titles) renders as plain text (#9).
 */
import * as React from 'react';
import { toast } from 'sonner';
import { Copy, Download, History as HistoryIcon, MoreHorizontal, RotateCcw, Send, Trash2 } from 'lucide-react';

import { Callout } from '@/design-system/callout';
import { api } from '@/lib/api';
import {
  createRunbook,
  discardRunbookDraft,
  duplicateRunbook,
  exportRunbookMarkdown,
  getRunbookDetail,
  markRunbookReviewed,
  previewRunbookMatch,
  publishRunbook,
  rejectRunbook,
  restoreRunbook,
  restoreRunbookVersionAsDraft,
  retireRunbook,
  saveRunbookDraft,
  submitRunbookForReview,
  validateRunbook,
} from '@/lib/api-runbooks';
import { downloadBlob } from '@/lib/download-blob';
import { humanizeAge } from '@/lib/format';
import type { Case } from '@/lib/types';
import type {
  MatchPreview,
  PhaseId,
  RunbookDefinition,
  RunbookDetail,
  RunbookIssue,
  RunbookSummary,
  RunbookTemplateValue,
  RunbookVersionDoc,
  StepKind,
} from '@/lib/types-runbooks';
import { useOptionalAuth } from '@/soc/auth';
import { useCan } from '@/soc/components/Can';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageHeader } from '@/soc/components/PageHeader';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { useDemo } from '@/soc/demo';
import { useUnsavedChanges } from '@/soc/hooks/useDirtyDraft';
import { useLiveAnnouncer } from '@/soc/hooks/useLiveAnnouncer';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { useRouteLinkClick } from '@/soc/route-link';
import { useNavigationBlocker } from '@/soc/router';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Label } from '@/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Textarea } from '@/ui/textarea';

import { ReadOnlyNote } from '../shared/chips';
import { isCaseFiguresHidden, runbookFailure, type RunbookApiFailure } from '../shared/errors';
import { PHASE_LABEL, RUNBOOK_LIMITS } from '../shared/labels';
import { AnalystPreview, type CaseValues } from './AnalystPreview';
import { AppliesWhenEditor, type CriteriaSuggestions } from './AppliesWhenEditor';
import { DetailsForm } from './DetailsForm';
import {
  addPhase,
  addStep,
  blankDefinition,
  currentIssues,
  fieldKey,
  mergeIssues,
  moveStep,
  moveStepBefore,
  placeIssues,
  removeStep,
  runbookIdFromTitle,
  sameDefinition,
  stepNumber,
  stepsWithIssues,
  visibleIssues,
  type KindFields,
  type PlacedIssue,
} from './draft';
import { focusField } from './fieldIds';
import { GovernanceStrip } from './GovernanceStrip';
import { HistorySheet } from './HistorySheet';
import { ISSUES_HEADING_ID, IssuesSummary, problemsLabel } from './IssuesSummary';
import { exportRunbookMarkdown as exportMarkdown, parseRunbookMarkdown } from './markdown';
import { MatchColumn, MatchResults, MatchSummaryButton, type MatchPanelState } from './MatchPanel';
import { DETAILS_ID, Outline } from './Outline';
import { SourceView } from './SourceView';
import { StepForm } from './StepForm';

export type EditorView = 'edit' | 'preview' | 'source';

/**
 * Edits typed while a create ran. The create saved what it sent, so the new runbook's own
 * page opens with these as unsaved changes rather than losing them.
 */
export interface RunbookCarriedEdits {
  /** The working copy, under the created runbook's id. */
  definition: RunbookDefinition;
  /** The Markdown, when the person was editing it in Source and it differs from what was sent. */
  source: string | null;
  /** The step (or Details) the person was on. */
  selected: string;
}

export interface RunbookEditorProps {
  /** The runbook id, or `new`. */
  runbookId: string;
  /** A detail already in hand (the response of a create or duplicate), to skip a read. */
  initialDetail?: RunbookDetail | null;
  /** Edits typed while the create that made this runbook ran: the page opens with them unsaved. */
  initialEdits?: RunbookCarriedEdits | null;
  /** A new runbook starts with this rule in Applies when ("Create a runbook" for a rule). */
  seedRule?: string | null;
  /** The library, for id suggestions and the criteria pickers. */
  library: RunbookSummary[];
  /** Rules seen recently, for the rule picker (from the metrics read). */
  recentRules?: string[];
  onOpenRunbook: (id: string, detail?: RunbookDetail, edits?: RunbookCarriedEdits) => void;
  onBackToLibrary: () => void;
}

const DEMO_READ_ONLY = 'Runbooks cannot be edited in Demo Mode.';
const CONFLICT_TEXT = 'Someone else changed this draft. Reload it to see their changes.';
const SAVE_FIRST = 'Save or discard your changes to use these.';
const READ_ONLY_NOTE_ID = 'runbook-read-only-note';

/** Where focus goes once a write settles (see the effect that fulfils it). */
type FocusAfter = 'issues' | 'conflict' | 'settled';

/** A soft-disabled control: it keeps focus while a request runs (WCAG 2.4.3), and says so. */
function softDisabled(off: boolean, className?: string): { 'aria-disabled'?: true; className?: string } {
  return off
    ? { 'aria-disabled': true, className: cn('cursor-not-allowed opacity-50', className) }
    : { className };
}

/** The editor's page heading, focusable from code so a hand-over can land on it. */
function focusHeading(root: HTMLElement | null): void {
  const h1 = root?.querySelector('h1');
  if (!h1) return;
  if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
  (h1 as HTMLElement).focus();
}

/** The outline item of a step (or the details item), for focus after a removal or a sheet. */
function outlineItem(root: ParentNode | null, id: string): HTMLElement | null {
  if (!root) return null;
  return id === DETAILS_ID
    ? (root.querySelector('[data-outline-item="details"]') as HTMLElement | null)
    : (root.querySelector(`[data-outline-step="${CSS.escape(id)}"]`) as HTMLElement | null);
}

/** "A runbook with the id 'x' already exists. Choose another id." for a taken id. */
export function takenIdMessage(id: string): string {
  return `A runbook with the id '${id}' already exists. Choose another id.`;
}
const VALIDATE_DELAY_MS = 450;
const MATCH_DELAY_MS = 900;

/** The version the editor shows: the draft, else the one in review, else the live one. */
export function workingVersion(detail: RunbookDetail | null): RunbookVersionDoc | null {
  if (!detail) return null;
  return detail.draft ?? detail.in_review ?? detail.live ?? null;
}

/** The case values a preview fills, read from one case (its primary entity, rule and source). */
export function caseValuesFrom(c: Case): CaseValues {
  const out: CaseValues = {};
  const entity = c.entity;
  const map: Record<string, RunbookTemplateValue> = {
    ip: 'entity.ip',
    user: 'entity.user',
    host: 'entity.host',
    domain: 'entity.domain',
    file_hash: 'entity.hash',
  };
  if (entity?.value && map[entity.type]) out[map[entity.type]] = entity.value;
  const rule = c.rule_ids?.[0];
  if (rule) out['case.rule'] = rule;
  if (c.source_id) out['case.source_id'] = c.source_id;
  return out;
}

function seededDefinition(seedRule: string | null | undefined): RunbookDefinition {
  const defn = blankDefinition();
  if (seedRule) defn.applies_when = { ...defn.applies_when, rule_ids: [seedRule] };
  return defn;
}

function headerIssue(issue: PlacedIssue): boolean {
  return issue.stepId === null && !issue.field.startsWith('applies_when');
}

export function RunbookEditor({
  runbookId,
  initialDetail,
  initialEdits,
  seedRule,
  library,
  recentRules = [],
  onOpenRunbook,
  onBackToLibrary,
}: RunbookEditorProps) {
  const isNew = runbookId === 'new';
  const username = useOptionalAuth()?.username ?? null;
  const canManage = useCan('runbooks', 'manage');
  const canPublish = useCan('runbooks', 'publish');
  const canCases = useCan('cases', 'read');
  const canSources = useCan('sources', 'read');
  const demo = useDemo().active;
  const isPhone = useMediaQuery('(max-width: 767px)');
  const isWide = useMediaQuery('(min-width: 1680px)');
  const { announce, LiveRegion } = useLiveAnnouncer();
  const libraryLinkClick = useRouteLinkClick('#/runbooks');

  const [detail, setDetail] = React.useState<RunbookDetail | null>(initialDetail ?? null);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error' | 'notfound'>(
    isNew || initialDetail ? 'ready' : 'loading',
  );
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const [reloadTick, setReloadTick] = React.useState(0);

  const version = workingVersion(detail);
  const baseline = React.useMemo<RunbookDefinition | null>(
    () => (isNew ? seededDefinition(seedRule) : version?.definition ?? null),
    // The seed only matters for a new runbook; a new detail resets the baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isNew, version],
  );
  // Edits carried over from a create open as unsaved changes (Markdown that does not read included).
  const carriedSource = initialEdits?.source ?? null;
  const [carriedParse] = React.useState(() => (carriedSource === null ? null : parseRunbookMarkdown(carriedSource)));
  const [working, setWorking] = React.useState<RunbookDefinition | null>(initialEdits?.definition ?? baseline);
  const [idEdited, setIdEdited] = React.useState(false);
  const [selected, setSelected] = React.useState<string>(DETAILS_ID);
  const [view, setView] = React.useState<EditorView>(carriedSource === null ? 'edit' : 'source');
  const [sourceText, setSourceText] = React.useState(carriedSource ?? '');
  const [sourceEdited, setSourceEdited] = React.useState(carriedSource !== null);
  const [sourceStale, setSourceStale] = React.useState(!!carriedParse && !carriedParse.definition);
  const [sourceIssues, setSourceIssues] = React.useState<RunbookIssue[]>(carriedParse?.issues ?? []);
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set());
  const [attempted, setAttempted] = React.useState(false);
  const [validation, setValidation] = React.useState<{
    issues: RunbookIssue[];
    defn: RunbookDefinition | null;
    chars: number;
    budget: number;
  } | null>(null);
  const [match, setMatch] = React.useState<{ state: MatchPanelState; preview: MatchPreview | null; error: string | null }>({
    state: canCases ? 'idle' : 'forbidden',
    preview: null,
    error: null,
  });
  const [matchTick, setMatchTick] = React.useState(0);
  const [matchOpen, setMatchOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [stepSheetOpen, setStepSheetOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<{ latest: RunbookDetail | null } | null>(null);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState('');
  const [pendingOpen, setPendingOpen] = React.useState<{
    id: string;
    detail?: RunbookDetail;
    edits?: RunbookCarriedEdits;
  } | null>(null);
  const [suggestions, setSuggestions] = React.useState<CriteriaSuggestions>({ rules: [], techniques: [], sources: [] });
  /** Ids a create was refused for (taken by another runbook), so the Id field says so. */
  const [refusedIds, setRefusedIds] = React.useState<ReadonlySet<string>>(() => new Set());
  /** Bumped to validate again at once (after a refused save, so the full list shows). */
  const [validateNonce, setValidateNonce] = React.useState(0);
  /** The view the person asked for while the Markdown does not read; a dialog asks first. */
  const [leaveSourceTo, setLeaveSourceTo] = React.useState<EditorView | null>(null);
  const pendingFocus = React.useRef<PlacedIssue | null>(null);
  const caseCache = React.useRef(new Map<string, CaseValues>());
  /**
   * The kind-specific fields each step set aside when its kind changed (see `switchStepKind`).
   * They belong to that step only: a step's entry goes when the step does (so a later step that
   * takes its id never inherits it), and every entry goes when the working copy is replaced.
   */
  const kindAside = React.useRef(new Map<string, KindFields>());
  /** What the person sees now, for a response that must tell what changed while it ran. */
  const live = React.useRef({ working, view, sourceEdited, sourceText, selected });
  React.useLayoutEffect(() => {
    live.current = { working, view, sourceEdited, sourceText, selected };
  });
  /**
   * The definition a write sent, keyed to the detail its response produced: the baseline
   * sync below replaces the working copy only when it still equals what was sent ('force'
   * when the person chose to replace it: Reload, Discard). A null detail means the next one
   * to arrive (a Reload that reads it again).
   */
  const syncRef = React.useRef<{ detail: RunbookDetail | null; sent: RunbookDefinition | 'force' } | null>(null);
  const focusAfter = React.useRef<FocusAfter | null>(null);
  /** A field to focus when the phone step sheet opens (instead of its first control). */
  const sheetFocus = React.useRef<{ stepId: string | null; field: string } | null>(null);
  /** A step just added from the outline's menu, whose title takes focus once the menu closes. */
  const newStepFocus = React.useRef<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const historyButtonRef = React.useRef<HTMLButtonElement>(null);
  const matchButtonRef = React.useRef<HTMLButtonElement>(null);
  const moreTriggerRef = React.useRef<HTMLButtonElement>(null);
  const reloadButtonRef = React.useRef<HTMLButtonElement>(null);
  const leaveSourceReturn = React.useRef<HTMLElement | null>(null);

  // ---- load --------------------------------------------------------------------------- //
  React.useEffect(() => {
    if (isNew || (initialDetail && reloadTick === 0)) return;
    const ctrl = new AbortController();
    setLoadState((s) => (s === 'ready' && detail ? s : 'loading'));
    getRunbookDetail(runbookId, ctrl.signal)
      .then((d) => {
        setDetail(d);
        setLoadState('ready');
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        const failure = runbookFailure(err, 'Could not load this runbook.');
        if (failure.code === 'runbook_not_found' || failure.status === 404) setLoadState('notfound');
        else {
          setLoadError(err);
          setLoadState('error');
        }
      });
    return () => ctrl.abort();
    // `detail` is read only to keep the page while a reload runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runbookId, isNew, reloadTick]);

  // A new detail (load, save, publish, reload) resets the working copy to its version, in
  // the same render, so the page never draws a frame without one. A write's response does so
  // only when the working copy still equals what that write sent: an edit typed while the
  // request ran is kept, and then reads as unsaved against the new baseline.
  const [syncedBaseline, setSyncedBaseline] = React.useState(baseline);
  if (baseline !== syncedBaseline) {
    const held = syncRef.current;
    const pending = held && (held.detail === null || held.detail === detail) ? held.sent : null;
    syncRef.current = null;
    const reference = pending === 'force' ? null : pending ?? syncedBaseline;
    const keepLocal = pending !== 'force' && !!working && !!reference && !sameDefinition(working, reference);
    setSyncedBaseline(baseline);
    // The person chose to replace their working copy (Reload, Discard): nothing set aside stays.
    if (pending === 'force') kindAside.current.clear();
    if (!keepLocal) {
      setWorking(baseline);
      setSourceEdited(false);
      setSourceStale(false);
      setSourceIssues([]);
      if (baseline && selected !== DETAILS_ID && !baseline.steps.some((s) => s.id === selected)) {
        setSelected(baseline.steps[0]?.id ?? DETAILS_ID);
      }
    }
  }

  // First load of an existing runbook: open on its first step, or where carried edits were made.
  const openedOn = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!baseline || openedOn.current === runbookId) return;
    openedOn.current = runbookId;
    const carriedAt = initialEdits?.selected;
    const carried =
      carriedAt && (carriedAt === DETAILS_ID || initialEdits.definition.steps.some((s) => s.id === carriedAt)) ? carriedAt : null;
    setSelected(carried ?? (isNew ? DETAILS_ID : baseline.steps[0]?.id ?? DETAILS_ID));
  }, [baseline, runbookId, isNew, initialEdits]);

  // A step that is gone takes what it set aside with it (see `kindAside`).
  React.useEffect(() => {
    if (!working) return;
    const ids = new Set(working.steps.map((s) => s.id));
    for (const id of Array.from(kindAside.current.keys())) if (!ids.has(id)) kindAside.current.delete(id);
  }, [working]);

  // Criteria suggestions: the rule catalogue, recent rules, techniques and sources (fail-soft).
  React.useEffect(() => {
    let alive = true;
    const libRules = library.flatMap((r) => r.applies_to.rule_ids);
    const libTechniques = library.flatMap((r) => r.applies_to.mitre);
    const attempt = <T,>(read: () => Promise<T>): Promise<T> => {
      try {
        return read();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    Promise.allSettled([attempt(() => api.rules.list()), attempt(() => api.listSources())]).then(([rules, sources]) => {
      if (!alive) return;
      const catalogue = rules.status === 'fulfilled' ? rules.value.detection ?? [] : [];
      const sourceList = sources.status === 'fulfilled' ? sources.value.sources ?? [] : [];
      const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).sort((a, b) => a.localeCompare(b));
      setSuggestions({
        rules: uniq([...catalogue.map((r) => r.name), ...recentRules, ...libRules]),
        techniques: uniq([...catalogue.flatMap((r) => r.mitre ?? []), ...libTechniques]),
        sources: [
          ...sourceList.map((s) => ({ value: s.id, label: s.display_name || s.id })),
          ...uniq(sourceList.map((s) => s.source_type)).map((t) => ({ value: `type:${t}`, label: `Any ${t} source` })),
        ],
      });
    });
    return () => {
      alive = false;
    };
    // Suggestions are read once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived ------------------------------------------------------------------------ //
  const summary = detail?.summary ?? null;
  const builtin = summary?.origin === 'builtin';
  const retired = !!summary?.retired;
  const readOnlyReason: string | null = demo
    ? DEMO_READ_ONLY
    : builtin
      ? null
      : !canManage
        ? 'You can view this runbook but not change it.'
        : retired
          ? 'Retired runbooks are read only. Restore it to publish it again.'
          : null;
  const readOnly = demo || builtin || !canManage || retired;
  // Markdown that does not read is an unsaved change wherever the person is.
  const changed = !!working && !!baseline && (!sameDefinition(working, baseline) || (sourceEdited && sourceStale));
  // Once a create or a copy hands over to the new runbook's own page, nothing is left unsaved here.
  const dirty = changed && !pendingOpen;
  const hasDraft = !!detail?.draft;
  const inReview = !!detail?.in_review && !detail?.draft;
  const publishable = detail?.draft ?? detail?.in_review ?? null;

  useUnsavedChanges(dirty && !readOnly);
  useNavigationBlocker(dirty && !readOnly, {
    title: 'Discard your changes to this runbook?',
    description: 'The edits since your last save are lost.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    sameRoute: true,
  });

  React.useEffect(() => {
    // Runs after the blocker above let go (React runs every cleanup of a commit first).
    if (!pendingOpen) return;
    if (pendingOpen.edits) onOpenRunbook(pendingOpen.id, pendingOpen.detail, pendingOpen.edits);
    else onOpenRunbook(pendingOpen.id, pendingOpen.detail);
  }, [pendingOpen, onOpenRunbook]);

  // ---- validation (debounced) ----------------------------------------------------------- //
  const useSource = view === 'source' && sourceEdited;
  const shouldValidate = !demo && (!readOnly || (canPublish && !!publishable && !retired && !builtin));
  const validateKey = !shouldValidate
    ? null
    : useSource
      ? `${validateNonce}|s:${sourceText}`
      : working
        ? `${validateNonce}|d:${JSON.stringify(working)}`
        : null;
  React.useEffect(() => {
    if (!validateKey || !working) return;
    const ctrl = new AbortController();
    const snapshot = working;
    const body = useSource ? { source: sourceText } : { definition: working };
    const timer = window.setTimeout(() => {
      validateRunbook(body, ctrl.signal)
        .then((v) =>
          setValidation({ issues: v.issues, defn: snapshot, chars: v.prompt_chars, budget: v.prompt_budget }),
        )
        .catch(() => {
          /* Validation is advisory while typing; a save still asks the server. */
        });
    }, VALIDATE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // `validateKey` captures the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validateKey]);

  // ---- match preview (debounced on the matching inputs only) ---------------------------- //
  const matchKey = working ? JSON.stringify([working.id, working.applies_when, working.priority, matchTick]) : null;
  React.useEffect(() => {
    if (!matchKey || !working) return;
    if (!canCases) {
      setMatch({ state: 'forbidden', preview: null, error: null });
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      setMatch((m) => ({ ...m, state: 'loading', error: null }));
      previewRunbookMatch({ definition: working }, ctrl.signal)
        .then((preview) => setMatch({ state: 'ready', preview, error: null }))
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          const failure = runbookFailure(err, 'Could not test this runbook against recent cases.');
          const hidden = isCaseFiguresHidden(failure);
          if (hidden) setMatch({ state: hidden, preview: null, error: null });
          else if (failure.code === 'runbook_invalid' || failure.status === 422) setMatch({ state: 'invalid', preview: null, error: null });
          else setMatch({ state: 'error', preview: null, error: failure.message });
        });
    }, MATCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // `matchKey` captures the matching inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, canCases]);

  // ---- issues ------------------------------------------------------------------------- //
  const takenIds = React.useMemo(() => [...library.map((r) => r.id), ...refusedIds], [library, refusedIds]);
  // A new runbook's id must be free: the library says so before a save, the server after one.
  const idTaken = isNew && !!working?.id && takenIds.includes(working.id);
  const placed = React.useMemo(() => {
    const found = validation ? currentIssues(placeIssues(validation.issues, validation.defn), validation.defn, working) : [];
    if (!idTaken || !working || found.some((i) => i.stepId === null && i.field === 'id')) return found;
    const taken: PlacedIssue = { path: 'id', code: 'exists', message: takenIdMessage(working.id), stepId: null, field: 'id' };
    return [taken, ...found];
  }, [validation, working, idTaken]);
  const shown = React.useMemo(
    () => visibleIssues(placed, { gated: isNew, attempted, touched }),
    [placed, isNew, attempted, touched],
  );
  const problemSteps = React.useMemo(() => {
    const set = stepsWithIssues(shown);
    if (shown.some(headerIssue)) set.add(DETAILS_ID);
    return set;
  }, [shown]);
  const issueCount = placed.length;
  // A new runbook's summary waits for a save attempt (its fields show their own problems
  // once left), so the list never appears under the pointer while the form is filled in.
  const summaryIssues = isNew && !attempted ? [] : shown;

  const touch = (stepId: string | null) => (field: string) =>
    setTouched((prev) => {
      const key = fieldKey(stepId, field);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });

  const goTo = (issue: PlacedIssue) => {
    pendingFocus.current = issue;
    setView('edit');
    const opensSheet = isPhone && (!!issue.stepId || headerIssue(issue));
    if (issue.stepId) setSelected(issue.stepId);
    else if (headerIssue(issue)) setSelected(DETAILS_ID);
    if (opensSheet) {
      // The sheet focuses the field as it opens (see its onOpenAutoFocus).
      sheetFocus.current = { stepId: issue.stepId, field: issue.field };
      pendingFocus.current = null;
      setStepSheetOpen(true);
      return;
    }
    // The field mounts on the next render.
    window.setTimeout(() => {
      const target = pendingFocus.current;
      pendingFocus.current = null;
      if (target) focusField(target.stepId, target.field);
    }, 0);
  };

  // Focus after a write settles: the problems after a refused save, Reload after a conflict,
  // and the heading when the control that was used is gone (Publish, Save once saved).
  React.useEffect(() => {
    const target = focusAfter.current;
    if (!target || busy !== null) return;
    focusAfter.current = null;
    if (target === 'issues') {
      const heading = document.getElementById(ISSUES_HEADING_ID);
      if (heading) {
        heading.focus();
        heading.scrollIntoView?.({ block: 'nearest' });
        return;
      }
    }
    if (target === 'conflict' && reloadButtonRef.current) {
      reloadButtonRef.current.focus();
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) focusHeading(rootRef.current);
  });

  // A create, a copy or an import hands a new runbook to this page: land on its heading.
  React.useEffect(() => {
    if (initialDetail) focusHeading(rootRef.current);
    // Only on mount, for the hand-over that mounted this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- editing ------------------------------------------------------------------------ //
  const change = (next: RunbookDefinition) => {
    if (readOnly) return;
    let value = next;
    if (isNew && !idEdited && working && next.title !== working.title) {
      value = { ...next, id: runbookIdFromTitle(next.title, takenIds) };
    }
    setWorking(value);
    if (sourceEdited && view !== 'source') setSourceEdited(false);
  };

  const selectStep = (id: string) => {
    setSelected(id);
    if (isPhone) setStepSheetOpen(true);
  };

  const onAddStep = (kind: StepKind) => {
    if (!working) return;
    const current = working.steps.find((s) => s.id === selected);
    const phase: PhaseId = current?.phase ?? working.steps[working.steps.length - 1]?.phase ?? 'triage';
    const { defn, id } = addStep(working, phase, kind);
    change(defn);
    openNewStep(id);
    announce(`Step ${stepNumber(defn, id).toLocaleString()} added to ${PHASE_LABEL[phase]}.`);
  };

  const onAddPhase = (phase: PhaseId) => {
    if (!working) return;
    const { defn, id } = addPhase(working, phase);
    change(defn);
    openNewStep(id);
    announce(`${PHASE_LABEL[phase]} added with one step.`);
  };

  /**
   * Select a step just added and put focus in its title, ready to name it: on a phone as its
   * sheet opens, otherwise once the Add menu has closed (it holds focus until then).
   */
  const openNewStep = (id: string) => {
    setSelected(id);
    if (isPhone) {
      sheetFocus.current = { stepId: id, field: 'title' };
      setStepSheetOpen(true);
      return;
    }
    newStepFocus.current = id;
  };
  const focusNewStep = () => {
    const id = newStepFocus.current;
    newStepFocus.current = null;
    if (id) window.setTimeout(() => focusField(id, 'title'), 0);
  };

  const describePlace = (defn: RunbookDefinition, id: string) => {
    const step = defn.steps.find((s) => s.id === id);
    if (!step) return '';
    const inPhase = defn.steps.filter((s) => s.phase === step.phase);
    return `${PHASE_LABEL[step.phase]}, step ${(inPhase.indexOf(step) + 1).toLocaleString()}`;
  };

  const onMove = (id: string, direction: -1 | 1) => {
    if (!working) return;
    const next = moveStep(working, id, direction);
    if (next === working) return;
    change(next);
    const step = next.steps.find((s) => s.id === id);
    announce(`Moved ${step?.title || 'the step'} to ${describePlace(next, id)}.`);
  };

  const onDrop = (id: string, beforeId: string | null, phase: PhaseId) => {
    if (!working) return;
    const next = moveStepBefore(working, id, beforeId, phase);
    change(next);
    const step = next.steps.find((s) => s.id === id);
    announce(`Moved ${step?.title || 'the step'} to ${describePlace(next, id)}.`);
  };

  const onRemove = (id: string) => {
    if (!working) return;
    const before = working;
    const setAside = kindAside.current.get(id);
    const index = before.steps.findIndex((s) => s.id === id);
    const next = removeStep(before, id);
    change(next);
    const nextSelected = next.steps[Math.min(index, next.steps.length - 1)]?.id ?? DETAILS_ID;
    setSelected(nextSelected);
    setStepSheetOpen(false);
    // The toast is the one message (assistive technology hears it once); focus moves to the
    // step now selected, so a second Enter never removes another step.
    toast('Step removed.', {
      action: {
        label: 'Undo',
        onClick: () => {
          // The step comes back with what it had set aside.
          if (setAside) kindAside.current.set(id, setAside);
          setWorking(before);
        },
      },
    });
    window.setTimeout(() => outlineItem(rootRef.current, nextSelected)?.focus(), 0);
  };

  const showView = (next: EditorView) => {
    if (!working) return;
    if (next === 'source') {
      setSourceText(exportMarkdown(working, publishable?.version ?? null));
      setSourceEdited(false);
      setSourceStale(false);
      setSourceIssues([]);
    } else if (view === 'source' && sourceStale) {
      // Leaving Markdown that does not read: the outline keeps the last version that did.
      setSourceEdited(false);
      setSourceStale(false);
      setSourceIssues([]);
    }
    setView(next);
  };

  const switchView = (next: EditorView) => {
    if (next === view || !working) return;
    if (view === 'source' && sourceEdited && sourceStale) {
      leaveSourceReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLeaveSourceTo(next);
      return;
    }
    showView(next);
  };

  const onSourceChange = (text: string) => {
    if (readOnly) return;
    setSourceText(text);
    setSourceEdited(true);
    const parsed = parseRunbookMarkdown(text);
    setSourceIssues(parsed.issues);
    if (parsed.definition) {
      setWorking(parsed.definition);
      setSourceStale(false);
    } else {
      setSourceStale(true);
    }
  };

  // ---- writes ------------------------------------------------------------------------- //
  /**
   * Show a detail a write returned. `sent` is the working copy that write sent (the closure's
   * `working` of the render that started it), or 'force' to replace the working copy whatever
   * it holds (Reload, Discard): see the baseline sync above.
   */
  const applyDetail = (next: RunbookDetail, message?: string, sent: RunbookDefinition | 'force' | null = working) => {
    if (sent) syncRef.current = { detail: next, sent };
    setDetail(next);
    setConflict(null);
    setAttempted(false);
    setTouched(new Set());
    if (message) {
      toast.success(message);
      announce(message);
    }
  };

  const failed = (err: unknown, fallback: string): RunbookApiFailure => {
    const failure = runbookFailure(err, fallback);
    // A create naming a taken id is not a stale revision: say so on the Id field, keep the form.
    if (failure.code === 'runbook_conflict' && (isNew || failure.exists)) {
      const id = working?.id ?? '';
      if (id) setRefusedIds((prev) => new Set(prev).add(id));
      setAttempted(true);
      toast.error(failure.message);
      if (working) goTo({ path: 'id', code: 'exists', message: failure.message, stepId: null, field: 'id' });
      return failure;
    }
    if (failure.code === 'runbook_conflict') {
      setConflict({ latest: failure.latest });
      if (working) {
        setSourceText(exportMarkdown(working, publishable?.version ?? null));
        setSourceEdited(true);
        setSourceStale(false);
        setView('source');
      }
      focusAfter.current = 'conflict';
      announce(CONFLICT_TEXT, 'assertive');
      return failure;
    }
    if (failure.code === 'runbook_invalid' && failure.issues.length) {
      // The server stops at the first problems it meets; keep every problem the last check of
      // this same text found as well, and check again at once for the full list. The summary
      // takes focus and says the count, so no toast repeats the server's partial one.
      setValidation((v) => ({
        issues: mergeIssues(failure.issues, v && sameDefinition(v.defn, working) ? v.issues : []),
        defn: working,
        chars: v?.chars ?? 0,
        budget: v?.budget ?? RUNBOOK_LIMITS.promptBudget,
      }));
      setAttempted(true);
      setValidateNonce((n) => n + 1);
      focusAfter.current = 'issues';
      return failure;
    }
    toast.error(failure.message);
    return failure;
  };

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try {
      await action();
    } finally {
      focusAfter.current = focusAfter.current ?? 'settled';
      setBusy(null);
    }
  };

  /**
   * What changed on this page since a create sent `sent`, carried to the created runbook
   * `id`, or null when nothing did. The working copy takes the created id (on a new runbook
   * the id follows the title until it is edited, and the created runbook keeps the id it got).
   */
  const editsSince = (
    sent: { definition: RunbookDefinition; source: string | null },
    id: string,
  ): RunbookCarriedEdits | null => {
    const now = live.current;
    if (!now.working) return null;
    const source = now.view === 'source' && now.sourceEdited && now.sourceText !== sent.source ? now.sourceText : null;
    if (source === null && sameDefinition(now.working, sent.definition)) return null;
    return { definition: { ...now.working, id }, source, selected: now.selected };
  };

  const save = () =>
    run('save', async () => {
      if (!working) return;
      setAttempted(true);
      try {
        if (isNew) {
          const sent = { definition: working, source: useSource ? sourceText : null };
          const created = await createRunbook(useSource ? { source: sourceText } : { definition: working });
          // Fields stay editable while the create runs: what was typed meanwhile goes with the
          // page to the new runbook's own address (the effect above), as unsaved changes there.
          const edits = editsSince(sent, created.summary.id);
          if (!edits) setWorking(workingVersion(created)?.definition ?? working);
          setPendingOpen({ id: created.summary.id, detail: created, edits: edits ?? undefined });
          const message = edits ? 'Draft saved. What you typed while it saved is kept as unsaved changes.' : 'Draft saved.';
          toast.success(message);
          announce(message);
          return;
        }
        if (!detail) return;
        const body = useSource
          ? { source: sourceText, expected_revision: detail.revision }
          : { definition: working, expected_revision: detail.revision };
        const next = await saveRunbookDraft(runbookId, body);
        applyDetail(next, next.revision === detail.revision ? 'No changes to save.' : 'Draft saved.', working);
      } catch (err) {
        failed(err, 'Could not save the draft.');
      }
    });

  const sendForReview = () =>
    run('submit', async () => {
      if (!detail?.draft) return;
      try {
        const next = await submitRunbookForReview(runbookId, {
          version: detail.draft.version,
          expected_revision: detail.revision,
        });
        applyDetail(next, 'Sent for review. Someone with publish rights can now publish it.');
      } catch (err) {
        failed(err, 'Could not send the draft for review.');
      }
    });

  const publish = () =>
    run('publish', async () => {
      if (!detail || !publishable) return;
      try {
        const next = await publishRunbook(runbookId, {
          version: publishable.version,
          expected_revision: detail.revision,
          content_hash: publishable.content_hash,
        });
        applyDetail(next, `Published v${publishable.version.toLocaleString()}. New cases get this version.`);
      } catch (err) {
        failed(err, 'Could not publish this version.');
      }
    });

  const reject = () =>
    run('reject', async () => {
      if (!detail?.in_review) return;
      const reason = rejectReason.trim();
      if (!reason) return;
      try {
        const next = await rejectRunbook(runbookId, {
          version: detail.in_review.version,
          reason,
          expected_revision: detail.revision,
        });
        setRejectOpen(false);
        setRejectReason('');
        applyDetail(next, 'Sent back to draft with your reason.');
      } catch (err) {
        failed(err, 'Could not send it back.');
      }
    });

  const simple = (label: string, call: () => Promise<RunbookDetail>, message: string, fallback: string) =>
    run(label, async () => {
      try {
        applyDetail(await call(), message);
      } catch (err) {
        failed(err, fallback);
      }
    });

  const retire = () =>
    simple('retire', () => retireRunbook(runbookId, { expected_revision: detail?.revision }), 'Retired. It no longer matches new cases.', 'Could not retire this runbook.');
  const restore = () =>
    simple('restore', () => restoreRunbook(runbookId, { expected_revision: detail?.revision }), 'Restored. It matches new cases again.', 'Could not restore this runbook.');
  const markReviewed = () =>
    simple('reviewed', () => markRunbookReviewed(runbookId, { expected_revision: detail?.revision }), 'Marked as reviewed.', 'Could not mark it as reviewed.');

  const duplicate = () =>
    run('duplicate', async () => {
      try {
        const copy = await duplicateRunbook(runbookId, { expected_revision: detail?.revision });
        toast.success('Copied. Your copy starts as a draft.');
        setPendingOpen({ id: copy.summary.id, detail: copy });
      } catch (err) {
        failed(err, 'Could not copy this runbook.');
      }
    });

  const discard = () =>
    run('discard', async () => {
      try {
        const result = await discardRunbookDraft(runbookId);
        setDiscardOpen(false);
        if (result.removed || !result.detail) {
          toast.success('Draft discarded.');
          setWorking(baseline);
          onBackToLibrary();
          return;
        }
        applyDetail(result.detail, 'Draft discarded.', 'force');
      } catch (err) {
        setDiscardOpen(false);
        failed(err, 'Could not discard the draft.');
      }
    });

  const restoreVersion = async (n: number) => {
    if (changed) return;
    try {
      const next = await restoreRunbookVersionAsDraft(runbookId, n, { expected_revision: detail?.revision });
      setHistoryOpen(false);
      applyDetail(next, `Version ${n.toLocaleString()} restored as a draft.`);
    } catch (err) {
      failed(err, 'Could not restore that version.');
    }
  };

  const exportMd = () =>
    run('export', async () => {
      try {
        const file = await exportRunbookMarkdown(runbookId);
        if (!downloadBlob(`${runbookId}.md`, file.blob)) toast.error('This browser could not start the download.');
      } catch (err) {
        toast.error(runbookFailure(err, 'Could not export this runbook.').message);
      }
    });

  const reload = () => {
    const latest = conflict?.latest;
    setConflict(null);
    setView('edit');
    setSourceEdited(false);
    setSourceStale(false);
    if (latest) applyDetail(latest, undefined, 'force');
    else {
      // The read that follows replaces the working copy: the person chose to reload.
      syncRef.current = { detail: null, sent: 'force' };
      setReloadTick((t) => t + 1);
    }
  };

  const loadCaseValues = async (caseId: string): Promise<CaseValues> => {
    const hit = caseCache.current.get(caseId);
    if (hit) return hit;
    const values = caseValuesFrom(await api.getCase(caseId));
    caseCache.current.set(caseId, values);
    return values;
  };

  // ---- render ------------------------------------------------------------------------- //
  if (loadState === 'loading' || (!isNew && loadState === 'ready' && !detail)) {
    return (
      <div className="space-y-4" aria-busy="true" data-runbook-editor="loading">
        <PageHeader title="Runbook" back={{ label: 'All runbooks', href: '#/runbooks' }} />
        <div className="surface-panel h-64 animate-pulse" />
      </div>
    );
  }
  if (loadState === 'notfound') {
    return (
      <div className="space-y-4" data-runbook-editor="notfound">
        <PageHeader title="Runbook not found" back={{ label: 'All runbooks', href: '#/runbooks' }} />
        <EmptyState
          title="This runbook does not exist."
          description="It may have been a draft that was discarded."
          action={
            <Button asChild variant="outline">
              <a href="#/runbooks" onClick={libraryLinkClick}>
                All runbooks
              </a>
            </Button>
          }
        />
      </div>
    );
  }
  if (loadState === 'error' || !working) {
    return (
      <div className="space-y-4" data-runbook-editor="error">
        <PageHeader title="Runbook" back={{ label: 'All runbooks', href: '#/runbooks' }} />
        <LoadError
          title="Could not load this runbook"
          error={loadError}
          onRetry={() => setReloadTick((t) => t + 1)}
          fallback="The runbook could not be read right now."
        />
      </div>
    );
  }

  const title = isNew ? 'New runbook' : summary?.title || working.title || runbookId;
  const selectedStep = working.steps.find((s) => s.id === selected) ?? null;
  const stepIssues = selectedStep ? shown.filter((i) => i.stepId === selectedStep.id) : [];
  const headerIssues = shown.filter(headerIssue);
  const appliesIssues = shown.filter((i) => i.stepId === null && i.field.startsWith('applies_when')).map((i) => i.message);
  const previewCases = match.preview
    ? [...match.preview.gets_it, ...match.preview.another_wins, ...match.preview.near_misses]
    : [];
  const testCases = previewCases.map((c) => ({ case_id: c.case_id, case_number: c.case_number, title: c.title }));
  const canTest = canManage && canSources && canCases && !demo && !readOnly;
  const guidance = !shouldValidate
    ? version
      ? { chars: version.prompt_chars, budget: RUNBOOK_LIMITS.promptBudget }
      : null
    : validation
      ? { chars: validation.chars, budget: validation.budget }
      : null;
  const savedStamp = dirty
    ? 'Unsaved changes'
    : hasDraft && summary?.updated_at && !Number.isNaN(Date.parse(summary.updated_at))
      ? `Draft saved ${humanizeAge(summary.updated_at)}`
      : null;
  const publishBlocked = issueCount > 0;

  const writeBusy = busy !== null;
  const readOnlyNoteId = readOnlyReason ? READ_ONLY_NOTE_ID : undefined;

  const primaryActions: React.ReactNode[] = [];
  if (!readOnly) {
    if (isNew || dirty || (!hasDraft && !inReview)) {
      primaryActions.push(
        <Button
          key="save"
          type="button"
          onClick={() => void save()}
          disabled={!isNew && !dirty}
          aria-busy={busy === 'save' || undefined}
          variant={dirty || isNew ? 'default' : 'outline'}
          {...softDisabled(writeBusy)}
        >
          Save draft
        </Button>,
      );
    }
    if (hasDraft && !dirty) {
      primaryActions.push(
        <Button
          key="submit"
          type="button"
          variant={canPublish ? 'outline' : 'default'}
          onClick={() => void sendForReview()}
          aria-busy={busy === 'submit' || undefined}
          {...softDisabled(writeBusy)}
        >
          <Send aria-hidden />
          Send for review
        </Button>,
      );
    }
  } else if (demo && canManage && !builtin && !retired) {
    // Demo Mode shows the write action it holds back, with the reason (§3.5).
    primaryActions.push(
      <Button
        key="save-demo"
        type="button"
        variant="outline"
        aria-describedby={readOnlyNoteId}
        onClick={() => undefined}
        {...softDisabled(true)}
      >
        Save draft
      </Button>,
    );
  }
  if (canPublish && !demo && !builtin && !retired && publishable && !dirty) {
    primaryActions.push(
      <Button
        key="publish"
        type="button"
        onClick={() => void publish()}
        disabled={publishBlocked}
        aria-busy={busy === 'publish' || undefined}
        data-publish=""
        {...softDisabled(writeBusy && !publishBlocked)}
      >
        {publishBlocked ? problemsLabel(issueCount) : 'Publish'}
      </Button>,
    );
  }
  if (builtin && canManage) {
    primaryActions.push(
      <Button
        key="duplicate"
        type="button"
        onClick={() => {
          if (!demo) void duplicate();
        }}
        aria-busy={busy === 'duplicate' || undefined}
        aria-describedby={demo ? readOnlyNoteId : undefined}
        {...softDisabled(writeBusy || demo)}
      >
        <Copy aria-hidden />
        Duplicate to customise
      </Button>,
    );
  }
  if (retired && canPublish && !demo) {
    primaryActions.push(
      <Button key="restore" type="button" onClick={() => void restore()} aria-busy={busy === 'restore' || undefined} {...softDisabled(writeBusy)}>
        <RotateCcw aria-hidden />
        Restore
      </Button>,
    );
  }

  const moreItems: React.ReactNode[] = [];
  // Actions that would replace unsaved edits wait until they are saved or discarded.
  let heldBack = false;
  if (!isNew && detail) {
    if (hasDraft && canManage && !demo) {
      moreItems.push(
        <DropdownMenuItem key="discard" onSelect={() => setDiscardOpen(true)} className="text-critical-text focus:text-critical-text">
          <Trash2 aria-hidden />
          Discard draft
        </DropdownMenuItem>,
      );
    }
    if (detail.in_review && canPublish && !demo) {
      heldBack ||= changed;
      moreItems.push(
        <DropdownMenuItem key="reject" disabled={changed} onSelect={() => setRejectOpen(true)}>
          Send back to draft
        </DropdownMenuItem>,
      );
    }
    if (!builtin && canManage && !demo) {
      heldBack ||= changed;
      moreItems.push(
        <DropdownMenuItem key="duplicate" disabled={changed} onSelect={() => void duplicate()}>
          <Copy aria-hidden />
          Duplicate
        </DropdownMenuItem>,
      );
    }
    if (detail.live && !retired && !builtin && canPublish && !demo) {
      heldBack ||= changed;
      moreItems.push(
        <DropdownMenuItem key="reviewed" disabled={changed} onSelect={() => void markReviewed()}>
          Mark reviewed
        </DropdownMenuItem>,
      );
    }
    if (detail.live && !retired && !builtin && canManage && !demo) {
      heldBack ||= changed;
      moreItems.push(
        <DropdownMenuItem key="retire" disabled={changed} onSelect={() => void retire()}>
          Retire
        </DropdownMenuItem>,
      );
    }
    if (moreItems.length) moreItems.push(<DropdownMenuSeparator key="sep" />);
    moreItems.push(
      <DropdownMenuItem key="export" onSelect={() => void exportMd()}>
        <Download aria-hidden />
        Export as Markdown
      </DropdownMenuItem>,
    );
  }

  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2" data-editor-actions="">
      {!isNew && detail ? (
        <Button ref={historyButtonRef} type="button" variant="ghost" onClick={() => setHistoryOpen(true)}>
          <HistoryIcon aria-hidden />
          History
        </Button>
      ) : null}
      {moreItems.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={moreTriggerRef} type="button" variant="outline" size="icon" aria-label="More actions">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {heldBack ? (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground" data-held-back="">
                {SAVE_FIRST}
              </DropdownMenuLabel>
            ) : null}
            {moreItems}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {primaryActions}
    </div>
  );

  const matchProps = {
    state: match.state,
    preview: match.preview,
    error: match.error,
    onRetry: () => setMatchTick((t) => t + 1),
  };

  const stepPane =
    selected === DETAILS_ID || !selectedStep ? (
      <DetailsForm
        defn={working}
        readOnly={readOnly}
        isNew={isNew}
        issues={headerIssues}
        onChange={change}
        onTouch={touch(null)}
        onIdEdited={() => setIdEdited(true)}
      />
    ) : (
      <StepForm
        defn={working}
        step={selectedStep}
        number={stepNumber(working, selectedStep.id)}
        readOnly={readOnly}
        issues={stepIssues}
        onChange={change}
        onTouch={touch(selectedStep.id)}
        onRemove={readOnly ? undefined : () => onRemove(selectedStep.id)}
        canTest={canTest}
        testCases={testCases}
        kindAside={kindAside}
      />
    );

  const mainPane =
    view === 'preview' ? (
      <AnalystPreview
        defn={working}
        cases={match.preview?.gets_it.length ? match.preview.gets_it : previewCases}
        loadCaseValues={canCases ? loadCaseValues : undefined}
        guidance={guidance}
      />
    ) : view === 'source' ? (
      <SourceView
        value={sourceText}
        onChange={readOnly ? undefined : onSourceChange}
        readOnly={readOnly}
        issues={useSource ? sourceIssues : []}
        stale={sourceStale}
      />
    ) : isPhone ? null : (
      stepPane
    );

  const returnTo = (ref: React.RefObject<HTMLElement | null>) => (event: Event) => {
    const target = ref.current;
    if (!target || !target.isConnected) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div ref={rootRef} className="space-y-4" data-runbook-editor={readOnly ? 'read-only' : 'edit'}>
      <LiveRegion />
      <PageHeader title={title} back={{ label: 'All runbooks', href: '#/runbooks' }} actions={actions} />
      {summary?.summary && !isNew ? <p className="-mt-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">{summary.summary}</p> : null}

      {conflict ? (
        <Callout
          intent="warning"
          title="Someone else changed this draft."
          action={
            <Button ref={reloadButtonRef} type="button" variant="outline" size="sm" onClick={reload}>
              Reload
            </Button>
          }
        >
          Reload it to see their changes. Your edit stays in the Source view until you reload.
        </Callout>
      ) : null}

      <GovernanceStrip detail={detail} username={username} isNew={isNew} dirty={dirty} canDuplicate={builtin && canManage && !demo} />

      {readOnlyReason ? <ReadOnlyNote id={READ_ONLY_NOTE_ID}>{readOnlyReason}</ReadOnlyNote> : null}

      <AppliesWhenEditor
        value={working.applies_when}
        onChange={readOnly ? undefined : (applies_when) => change({ ...working, applies_when })}
        readOnly={readOnly}
        suggestions={suggestions}
        issues={appliesIssues}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl<EditorView>
          aria-label="View"
          size="sm"
          value={view}
          onValueChange={switchView}
          options={[
            { value: 'edit', label: readOnly ? 'Steps' : 'Edit' },
            { value: 'preview', label: 'Preview as analyst' },
            { value: 'source', label: 'Source' },
          ]}
        />
        {!isWide ? (
          <MatchSummaryButton buttonRef={matchButtonRef} state={match.state} preview={match.preview} onOpen={() => setMatchOpen(true)} />
        ) : null}
        {savedStamp ? (
          <span className="ml-auto text-sm text-muted-foreground" data-saved-stamp="">
            {savedStamp}
          </span>
        ) : null}
      </div>

      <div
        className="grid min-w-0 items-start gap-4 md:grid-cols-[minmax(15rem,18rem)_minmax(0,1fr)] min-[1680px]:grid-cols-[18rem_minmax(0,1fr)_22rem]"
        data-editor-layout={isWide ? 'three' : isPhone ? 'phone' : 'two'}
      >
        {/* The outline, and under it the problems: a list that grows or shrinks while someone
            types never moves the field they are typing in. */}
        <div className="min-w-0 space-y-4" data-editor-side="">
          {view === 'edit' || !isPhone ? (
            <Outline
              defn={working}
              selected={selected}
              onSelect={selectStep}
              readOnly={readOnly}
              problems={problemSteps}
              onAddStep={readOnly ? undefined : onAddStep}
              onAddPhase={readOnly ? undefined : onAddPhase}
              onMove={readOnly ? undefined : onMove}
              onDrop={readOnly ? undefined : onDrop}
              onAddedMenuClosed={focusNewStep}
            />
          ) : null}
          <IssuesSummary issues={summaryIssues} defn={working} onGoTo={goTo} total={summaryIssues.length} />
        </div>
        {mainPane ? <div className="min-w-0">{mainPane}</div> : null}
        {isWide ? <MatchColumn {...matchProps} /> : null}
      </div>

      {isPhone ? (
        <Sheet open={stepSheetOpen && view === 'edit'} onOpenChange={setStepSheetOpen}>
          {/* `pt-12` keeps the sheet's close button above the step panel, clear of its
              "Read only" note and header actions. */}
          <SheetContent
            side="right"
            size="full"
            className="overflow-y-auto p-3 pt-12"
            data-step-sheet=""
            onOpenAutoFocus={(event) => {
              const target = sheetFocus.current;
              sheetFocus.current = null;
              if (!target) return;
              event.preventDefault();
              window.setTimeout(() => focusField(target.stepId, target.field), 0);
            }}
            onCloseAutoFocus={(event) => {
              const item = outlineItem(rootRef.current, selected);
              if (!item) return;
              event.preventDefault();
              item.focus();
            }}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{selected === DETAILS_ID ? 'Edit the runbook details' : `Edit step ${stepNumber(working, selected).toLocaleString()}`}</SheetTitle>
              <SheetDescription>Edit the selected part of the runbook.</SheetDescription>
            </SheetHeader>
            {stepPane}
          </SheetContent>
        </Sheet>
      ) : null}

      {!isWide ? (
        <Sheet open={matchOpen} onOpenChange={setMatchOpen}>
          <SheetContent side="right" size="default" className="overflow-y-auto" data-match-sheet="" onCloseAutoFocus={returnTo(matchButtonRef)}>
            <SheetHeader>
              <SheetTitle>Which cases would this match?</SheetTitle>
              <SheetDescription>This version tested against recent cases.</SheetDescription>
            </SheetHeader>
            <MatchResults {...matchProps} className="p-6" />
          </SheetContent>
        </Sheet>
      ) : null}

      {detail && !isNew ? (
        <HistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          detail={detail}
          canRestore={canManage && !demo && !builtin}
          restoreBlocked={changed ? 'Save or discard your changes first, so restoring a version does not replace them.' : null}
          onRestore={restoreVersion}
          returnFocusRef={historyButtonRef}
        />
      ) : null}

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this draft?"
        description={
          detail?.live
            ? 'The draft is deleted. The live version stays as it is.'
            : 'This runbook was never published, so discarding the draft removes it.'
        }
        confirmLabel="Discard draft"
        destructive
        returnFocusRef={moreTriggerRef}
        onConfirm={() => void discard()}
      />

      <ConfirmDialog
        open={leaveSourceTo !== null}
        onOpenChange={(open) => {
          if (!open) setLeaveSourceTo(null);
        }}
        title="Leave the Markdown with problems?"
        description="The Markdown does not read as a runbook, so your last changes there are not kept. The outline keeps the last version that read correctly."
        confirmLabel="Leave and lose those changes"
        cancelLabel="Keep editing the Markdown"
        returnFocusRef={leaveSourceReturn}
        onConfirm={() => {
          const next = leaveSourceTo;
          setLeaveSourceTo(null);
          if (next) showView(next);
        }}
      />

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent onCloseAutoFocus={returnTo(moreTriggerRef)}>
          <DialogHeader>
            <DialogTitle>Send back to draft</DialogTitle>
            <DialogDescription>The author sees your reason on the draft. Nothing is published.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="runbook-reject-reason">Reason</Label>
            <Textarea
              id="runbook-reject-reason"
              rows={3}
              maxLength={500}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void reject()}
              disabled={!rejectReason.trim()}
              aria-busy={busy === 'reject' || undefined}
              {...softDisabled(writeBusy)}
            >
              Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default RunbookEditor;
