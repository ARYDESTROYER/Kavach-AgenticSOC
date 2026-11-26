/**
 * CaseDetail: the core analyst workflow surface (thin orchestrator).
 *
 * Opened with a `caseId`, it fetches the full case (`api.getCase`) and presents it in one
 * of two hosts: embedded in the Case Manager split, or a wide right-side Sheet (the
 * Overview dashboard and Investigate open it that way). The same tree renders in both.
 * Round 16 (SPEC D8, §4.4 WP03): one question per region.
 *
 *   - a compact sticky header, 118px for every case: row 1 (44px) holds the title on one
 *     line, ONE primary contextual action (`actionPlanForStatus`), the Take action menu
 *     holding every other verb, Ask AI, a "More options" menu (copy link, open in new
 *     tab), the inspector toggle (`]`) and, embedded, Back; row 2 is the 24px meta strip
 *     that never wraps (`CaseHeaderMeta`: case number, severity, status or outcome, the
 *     Risk chip, the AI verdict with the AI run chip, the owner, the SLA and the review
 *     chip); then the 36px tabs;
 *   - six tabs, one lane each (D8): Brief (`overview`: the Next step row, the four lanes
 *     and the folded story of how the case was built), Evidence (`evidence`: what
 *     happened, the events, entities, threat context, related cases, baseline), AI
 *     investigation (`investigation`: the assessment, the inputs, the trace and the
 *     gradings), Response (`runbook`: the runbook for a viewer who may read it, and the
 *     tasks for everyone; lazy), Activity (`collab`: discussion, files, history) and Chat,
 *     on Alt+1 to Alt+6. A link to a retired tab id, or to a section that moved, opens the
 *     tab it is on now and scrolls to the section;
 *   - the inspector (the facts rail) beside every tab from a 52rem pane, shown or hidden
 *     with `]` and kept per viewer; narrower panes open it in a non-blocking side sheet;
 *   - the auto-close review (Round 15): on a pending sample, the meta strip's review chip,
 *     the Brief's review note and Start review as the primary action; on any other case
 *     the agent closed, "Review this auto-close" in Take action in place of Set
 *     disposition. Both open the review card in a non-blocking side sheet;
 *   - the Activity tab's Files and the close dialog's "Add screenshots", both lazy chunks
 *     of the screenshots kit;
 *   - the shared confirm-action dialog (every lifecycle action), the Reinvestigate dialog
 *     (`ReinvestigateDialog`) and Notify.
 *
 * The case's runbook runs are read once here and shared by the Response tab, the Brief's
 * Next step row and People lane, and the close dialog (which asks why when required steps
 * are open). The settings are read only for a holder of `settings:read`; without it, the
 * auto-close entry for the case's verdict and the SLA reading come from the triage read
 * (C60), so a person who may read cases never writes an Access denied row by opening one.
 *
 * COUPLING-D SPLIT: the conceptual panels live in `soc/pages/casedetail/*`, the lifecycle
 * action model and small building blocks in `./shared`, and the close-with-disposition
 * dialog in `./ConfirmActionDialog`. This file is the ORCHESTRATOR: it owns the
 * fetch, lazy-load and mutation state and wires it to the panels.
 *
 * Contract: `CaseDetail({ caseId, onClose, onNavigate?, presentation? })`: a null or
 * empty `caseId` renders nothing (closed). Case Manager uses the `embedded` presentation;
 * every other host uses the default right-side sheet, with the same panels, RBAC gates and
 * deterministic lifecycle actions.
 *
 * SECURITY (#9): every case-derived value (title, summary, entity, IPs, rules, queries,
 * evidence, tool output, comments, tags, model keys, enrichment) is UNTRUSTED: it is
 * rendered as plain text or inside <CodeBlock>/<InlineCode>, never as markup.
 * #3: the unified Close-with-disposition still POSTs the EXISTING `close` verb (via
 * `wireAction`) so the backend runs the real decide()/apply(); this file never invents a
 * verb or makes a close/escalate decision itself.
 */
import * as React from 'react';
import {
  AlertTriangle,
  BookCheck,
  Bot,
  ChevronDown,
  ChevronLeft,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileText,
  Link2,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  RefreshCw,
  Send,
  Shield,
  Tag as TagIcon,
  UserCheck,
  X,
  Zap,
} from 'lucide-react';

import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import type {
  AutoClosePolicy,
  Case,
  CaseActionInput,
  CaseRationale,
  ModelsResponse,
  SlaPolicy,
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import type { AssetRangeReading, SlaReadingWire } from '@/lib/explain/builders';
import { downloadText } from '@/lib/download';
import { errorMessage } from '@/lib/errorMessage';
import { humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';
import { AGENT_STEP_CHANNEL, useEventStream, type StreamEvent } from '@/lib/useEventStream';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Sheet, SheetContent, SheetTitle } from '@/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
// motion.dev (lazy: CaseDetail is loaded off a lazy route chunk, never the eager
// first-paint graph): the tab-body cross-fade and the DecisionCard "verdict lands" one-shot.
// CaseDetail mounts its OWN MotionProvider so in-page motion works even on a deep link.
import { MotionProvider, TabPanelMotion, useReducedMotion } from '@/soc/components/motion';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/ui/dropdown-menu';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/ui/tooltip';
import { Skeleton } from '@/ui/skeleton';
import { LoadingBar, LoadingState, materialBar } from '@/design-system';

import { caseOutcome } from '@/soc/components/outcome';
import { visibleMessageCount } from '@/soc/components/CaseThread';
import { useCan } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';

import {
  getTriage,
  getTimeline,
  getCaseStages,
  getThread,
  postThread,
  editThreadMessage,
  deleteThreadMessage,
  reactThreadMessage,
  getActivity,
  listPickableUsers,
  type TriageChips,
  type TimelineResponse,
  type TimelineStagesResponse,
  type CaseMessage as ThreadMessage,
  type CaseActivityItem,
  type PickableUser,
} from '@/soc/pages/CaseDetail.api';

import type { Navigate } from '@/soc/router';
// The case tabs in order (Alt+1 to Alt+6 select them), shared with the router's
// `tab` deep-link key so the two lists can never drift.
import { CASE_SECTION_TABS, CASE_TABS, isCaseTab, type CaseTab } from '@/soc/case-tabs';
import { useAiRun } from '@/soc/investigations/useAiRun';
// Already in this chunk through the AI investigation tab, so the tab count adds no code.
import { traceStepCounts } from '@/soc/components/TraceTimeline';
import { ReinvestigateDialog, reinvestigateErrorText } from '@/soc/investigations/ReinvestigateDialog';

import { campaignsApi, type Campaign } from '@/soc/pages/Campaigns.api';

import {
  type ActionDef,
  type ActionKind,
  type FpPolicy,
  type NotifyChannelOption,
  type WireActionTaken,
  ACTION_PERMISSION,
  CASE_MANAGER_PANEL_PADDING,
  PanelSection,
  actionPlanForStatus,
  planCloseAction,
  policyForVerdict,
} from './casedetail/shared';
import { OverviewPanel } from './casedetail/OverviewPanel';
import { EvidencePanel } from './casedetail/EvidencePanel';
import { TimelinePanel } from './casedetail/TimelinePanel';
import { InvestigationPanel } from './casedetail/InvestigationPanel';
import { ThreatContextPanel } from './casedetail/ThreatContextPanel';
import { triageAssetCidr, triageAutoClosePolicy, triageSla } from './casedetail/triageReads';
import { CollaborationThreadTab } from './casedetail/CollaborationPanel';
import { ChatTab } from './casedetail/CaseChatPanel';
import { ConfirmActionDialog } from './casedetail/ConfirmActionDialog';
import { CaseHeaderMeta } from './casedetail/CaseHeaderMeta';
import { FactsRail } from './casedetail/FactsRail';
import { shortcutBlocked } from './casedetail/keyboard';
import { isAgentClosedCase, keepAdvisoryBands } from './casedetail/queue';
import {
  REVIEW_MENU_LABEL,
  START_REVIEW_HELP,
  START_REVIEW_LABEL,
  reviewActionLayout,
} from './casedetail/review/review-plan';
import { useCaseReviewState } from './casedetail/review/useCaseReviewState';
import { ReviewSheet, loadReviewCard } from './casedetail/review/ReviewSheet';
import { notifyResultToast } from './casedetail/notifyResult';
import { CaseChatActivityGlyph, useCaseChatRequest } from '@/soc/chat-activity/case-glyph';
import { useCaseRunbooks } from '@/soc/runbooks/run/useCaseRunbooks';
import {
  caseProgress,
  openRequiredSteps,
  openStepsFromRefusal,
  primaryRun,
  type OpenRequiredStep,
} from '@/soc/runbooks/run/model';
import { RunbookTabCount } from '@/soc/runbooks/run/ProgressChip';
import { OtherTasksLoader } from '@/soc/runbooks/run/OtherTasks';
import type { RunbookStepsOpen } from '@/lib/types-runbooks';
import type { RunbookFocusRequest } from './casedetail/RunbookPanel';

/** A Runbook tab request without its tick (the tick is added when it is made). */
type WithoutTick<T> = T extends unknown ? Omit<T, 'tick'> : never;
type RunbookRequestKind = WithoutTick<RunbookFocusRequest>;
import {
  deriveAgreement,
  emptyGradingDraft,
  gradingToFeedbackInput,
  isGradingDirty,
  requiresDisagreementNote,
  type GradingDraft,
} from './casedetail/grading';

// Re-export the co-located API types so existing importers keep working.
export type { ThreadMessage };

// The Runbook tab's body is lazy (SPEC §3.4, §4.10.11): its chunk loads when the tab opens.
const RunbookPanel = React.lazy(() => import('./casedetail/RunbookPanel'));
// The screenshots kit (Round 15, D5.12, D4.6): the Files section loads with the
// Collaboration tab and the close dialog's drop zone with the dialog, never before.
const CaseFiles = React.lazy(() => import('./casedetail/files/CaseFiles').then((m) => ({ default: m.CaseFiles })));
const CloseScreenshots = React.lazy(() => import('./casedetail/files/CloseScreenshots'));
/** How long a burst of screenshot frames waits before the Files section re-reads. */
const FILES_REFRESH_MS = 400;

/** The runbook settings the case surfaces read (absent keys keep the defaults: on). */
interface RunbookPrefs {
  enabled: boolean;
  aiSuggest: boolean;
  aiDrafts: boolean;
}
const DEFAULT_RUNBOOK_PREFS: RunbookPrefs = { enabled: true, aiSuggest: true, aiDrafts: true };

function readRunbookPrefs(prefs: unknown): RunbookPrefs {
  const block = prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>).runbooks : null;
  if (!block || typeof block !== 'object') return DEFAULT_RUNBOOK_PREFS;
  const b = block as Record<string, unknown>;
  return {
    enabled: b.enabled !== false,
    aiSuggest: b.ai_suggest !== false,
    aiDrafts: b.ai_step_drafts !== false,
  };
}

/** The steps a `409 runbook_steps_open` named, when the refusal is one. */
function stepsOpenRefusal(error: unknown): RunbookStepsOpen[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !error.body || typeof error.body !== 'object') return null;
  const detail = (error.body as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object' || (detail as { code?: unknown }).code !== 'runbook_steps_open') return null;
  const steps = (detail as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(
    (s): s is RunbookStepsOpen =>
      Boolean(s) && typeof s === 'object' && typeof (s as RunbookStepsOpen).step_id === 'string' && typeof (s as RunbookStepsOpen).title === 'string',
  );
}

/**
 * The toast for a reinvestigation that did not start (it lives with the Reinvestigate
 * dialog; re-exported for existing importers).
 */
export { reinvestigateErrorText };

/** Why Take action's Reinvestigate is unavailable while a run is queued or running. */
export const REINVESTIGATE_RUNNING_HINT = 'An AI investigation is already running.';

/** Where the inspector's shown or hidden state is kept (a per-viewer convenience). */
export const INSPECTOR_KEY = 'soc.caseManager.inspector';

function readInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writeInspectorOpen(open: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_KEY, open ? 'open' : 'closed');
  } catch {
    /* private mode or blocked storage: the toggle still works for this page. */
  }
}

/**
 * Is `el` laid out right now? The inspector column is `hidden` below a 52rem pane by a
 * container query, so connected is not enough. `checkVisibility()` where the browser has
 * it, else no ancestor with display:none.
 */
function elementShown(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el);
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (view.getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** A case already resolved or closed (a further close is its final close, never asked about). */
function caseIsTerminal(status?: string | null): boolean {
  const s = String(status ?? '').toLowerCase();
  return s === 'closed' || s === 'resolved';
}

/** Which wire verbs end a case (the close dialog asks about open runbook steps for them). */
function isTerminalVerb(verb: string, status?: string | null): boolean {
  if (verb === 'close' || verb === 'resolve') return true;
  return verb === 'set_status' && (status === 'closed' || status === 'resolved');
}

/**
 * The sections a link can ask the case to scroll to, and their tab (Round 16, D8: all on
 * Evidence). A closed set, so a value from an address never reaches a selector.
 */
const CASE_SECTIONS: Readonly<Record<string, CaseTab>> = CASE_SECTION_TABS;

/** Evidence's "What happened" shows only the ingestion stage of the story (the source lane). */
const SOURCE_STAGES: readonly string[] = ['input'];

/** How long a requested section is held in place while the content above it loads. */
const SECTION_HOLD_MS = 2500;
/** What the analyst does in the lane that ends the hold (they took over the scroll). */
const SECTION_HOLD_RELEASE = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/* --------------------------------------------------------------- component -- */

type CaseDetailPresentation = 'sheet' | 'embedded';

/**
 * Presentation-only shell around the shared case workflow. Keeping this wrapper tiny
 * is deliberate: the substantial child tree below is identical in the legacy Sheet
 * and the new inline Case Manager, so actions and lazy panel loaders cannot drift.
 */
const CaseDetailSurface: React.FC<{
  presentation: CaseDetailPresentation;
  open: boolean;
  onClose: () => void;
  /** The case title: the sheet focuses it on open (CM-9), never an icon button. */
  titleRef?: React.RefObject<HTMLHeadingElement | null>;
  children: React.ReactNode;
}> = ({ presentation, open, onClose, titleRef, children }) => {
  /**
   * The element that had focus when this sheet opened, so closing can give it back.
   *
   * Captured during RENDER, not in an effect, and that is load-bearing: child effects run
   * before a parent's, so by the time any effect of ours could run, Radix's `FocusScope`
   * has already moved focus into the sheet and the opener is gone. The render pass that
   * first sees `open` is the last moment the opener still holds focus. Reading
   * `document.activeElement` is a pure read (nothing is mutated) so this is safe in
   * render, and the ref deliberately is NOT cleared when `open` goes false, because the
   * close handler that consumes it runs after that render (and after unmount, since Radix
   * routes the same callback through `onUnmountAutoFocus`).
   */
  const openerRef = React.useRef<HTMLElement | null>(null);
  if (open && !openerRef.current && typeof document !== 'undefined') {
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }

  if (presentation === 'embedded') {
    return (
      <section
        aria-label="Case detail"
        className="h-full min-h-0 overflow-hidden bg-background"
      >
        {children}
      </section>
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <SheetContent
        side="right"
        size="full"
        className="w-full max-w-[min(98vw,1400px)] p-0"
        aria-label="Case detail"
        aria-describedby={undefined}
        // Focus the case TITLE on open (CM-9): Radix's default lands on the first
        // focusable control, an icon button, whose tooltip then opened by itself.
        onOpenAutoFocus={(event) => {
          const title = titleRef?.current;
          if (title) {
            event.preventDefault();
            title.focus();
          }
        }}
        /**
         * Focus RETURN on close (WCAG 2.4.3), which Radix cannot do for this sheet.
         *
         * `DialogContent` hard-wires its own `onCloseAutoFocus` to
         * `event.preventDefault(); context.triggerRef.current?.focus()`. That
         * `preventDefault()` also suppresses `FocusScope`'s own restore-to-previous
         * behaviour, and `triggerRef` is null here because this sheet is opened by STATE
         * (a row, a table cell, a queue item elsewhere on the page) rather than by a
         * `<SheetTrigger>`. The result was focus landing on `<body>`: a keyboard operator
         * who pressed Escape lost their place in the list entirely.
         *
         * So the opener is captured and restored explicitly. `composeEventHandlers` runs
         * this handler BEFORE Radix's, and skips Radix's once this one has prevented the
         * default: the same pattern the Tuning inspector already uses.
         *
         * Every consumer benefits: Cases, Scans, Investigate and the dashboard all mount
         * this one surface, and every one of them opens it from state.
         */
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          // Only claim the default when there is somewhere real to send focus. A opener
          // that has since unmounted (its row re-rendered away, its page navigated) is
          // left to Radix rather than focused blind.
          if (opener && opener.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        {children}
      </SheetContent>
    </Sheet>
  );
};

export interface CaseDetailProps {
  caseId: string | null | undefined;
  onClose: () => void;
  onNavigate?: Navigate;
  /** Default `sheet`; Case Manager uses `embedded` inside its selected-case pane. */
  presentation?: CaseDetailPresentation;
  /** Emits the authoritative server case after loads and mutations (queue sync only). */
  onCaseChange?: (next: Case) => void;
  /**
   * The case as the caller already has it (Case Manager: the queue row, which is the full
   * case document). When it matches `caseId` it renders IMMEDIATELY while the
   * authoritative copy loads in the background, so switching cases never blanks the
   * pane (CM-5). Display only; every action still targets the server's copy.
   */
  previewCase?: Case | null;
  /**
   * "Close & next" (Case Manager): called after a terminal action succeeds so the queue
   * advances to the next case. Omitted → the close dialog offers plain Close only.
   */
  onAdvance?: () => void;
  /**
   * Case Manager: where focus lands after a lifecycle dialog closes on a submit, when the
   * dialog's opener may have left (a queue row the action took out of the view). Returns
   * null to keep the dialog's default (its opener).
   */
  resolveDialogFocus?: (opener: HTMLElement | null, andNext: boolean) => HTMLElement | null;
  /**
   * The tab a link asks for (Case Manager's `tab` deep-link key: the audit log's "Open
   * case trace" asks for `investigation`), by its id; any other value is ignored. It
   * applies when it, or the case, changes; the analyst's own tab choice stands until
   * then. Every tab is shown to every viewer (Round 16: Response always lists the tasks).
   */
  requestedTab?: string | null;
  /**
   * The section of the requested tab a link asks for (a link to a retired tab id, or to
   * a section that moved, is rewritten to the tab it is on now: `what-happened`,
   * `threat-context` and `related-cases` are on Evidence). The case scrolls it into view
   * once; any other value is ignored.
   */
  requestedSection?: string | null;
  /**
   * Round 15 (D6.12): bump to re-read the case's auto-close review state (Case Manager
   * passes one on a `case.review` frame for the open case).
   */
  reviewRefreshKey?: number;
  /** Called after a review is recorded or the case reopened from it (the queue re-reads). */
  onReviewChange?: () => void;
}

export const CaseDetail: React.FC<CaseDetailProps> = ({
  caseId,
  onClose,
  onNavigate,
  presentation = 'sheet',
  onCaseChange,
  previewCase = null,
  onAdvance,
  resolveDialogFocus,
  requestedTab: requestedTabId = null,
  requestedSection: requestedSectionId = null,
  reviewRefreshKey = 0,
  onReviewChange,
}) => {
  const requestedTab = isCaseTab(requestedTabId) ? requestedTabId : null;
  const requestedSection =
    requestedTab && requestedSectionId && CASE_SECTIONS[requestedSectionId] === requestedTab ? requestedSectionId : null;
  const reduceMotion = useReducedMotion();
  const open = Boolean(caseId && caseId.trim());
  const id = caseId || '';

  // Staleness guard: the LATEST requested case id. Every id-keyed loader captures its
  // own `id` in a closure and applies its result ONLY if the case has not changed
  // mid-flight: the SAME CaseDetail instance is reused across cases (related-case
  // drill-through, reopening the sheet on a different row), so a slow response for
  // case A must never overwrite the freshly-opened case B. A lazy loader also starts
  // only for the case on screen: a callback that outlives its case (a post that lands
  // after the switch, a live refresh timer) would otherwise set the next case's loading
  // flag for a read whose result is then dropped, leaving that flag set for good.
  const activeIdRef = React.useRef(id);
  React.useEffect(() => {
    activeIdRef.current = id;
  }, [id]);

  const [c, setC] = React.useState<Case | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // The case on screen, read by `commitCase`: a mutation response for it that omits the
  // read-time advisory bands keeps the ones shown (`keepAdvisoryBands`, Round 12 final
  // review), so the header never relabels a Critical case from the risk-score ladder.
  const shownCaseRef = React.useRef<Case | null>(null);
  shownCaseRef.current = c;

  const commitCase = React.useCallback(
    (incoming: Case) => {
      const next = keepAdvisoryBands(shownCaseRef.current, incoming);
      shownCaseRef.current = next;
      setC(next);
      onCaseChange?.(next);
    },
    [onCaseChange],
  );

  // Campaign membership (#51): the cross-case campaign this case belongs to, if any.
  // Advisory only (#3/#4): a campaign is a reporting grouping that never closes /
  // escalates / re-clusters the case. Best-effort: campaigns may be disabled.
  const [campaign, setCampaign] = React.useState<Campaign | null>(null);
  // A requested tab opens on the first paint (no Brief flash).
  const [tab, setTab] = React.useState<CaseTab>(() => requestedTab ?? 'overview');
  // Round 12 (SPEC D13): "Open" on a case-chat toast lands on this case's Chat tab.
  useCaseChatRequest(open ? id : null, () => setTab('chat'));
  const panelScrollRef = React.useRef<HTMLDivElement>(null);

  // Every tab shares one scroll lane. Reset it when the selected tab/case changes so a
  // deep Overview scroll never opens Investigation halfway down the trace.
  React.useEffect(() => {
    if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
  }, [tab, id]);

  // A section of a tab to bring into view: Evidence's "What happened", "Threat context" and
  // "Related cases", asked for by a rewritten link or from inside the case (the
  // inspector's related cases, a finding's events). A new tick per request, applied once
  // the tab is on screen and then forgotten, so it is never replayed.
  // An in-page request also moves focus to the section's heading; a link's request only
  // scrolls, so it never takes focus from the queue.
  const [sectionRequest, setSectionRequest] = React.useState<{ section: string; tick: number; focus: boolean } | null>(
    null,
  );
  const sectionTickRef = React.useRef(0);
  const openTabSection = React.useCallback((next: CaseTab, section?: string) => {
    setTab(next);
    if (section && CASE_SECTIONS[section] === next) {
      sectionTickRef.current += 1;
      setSectionRequest({ section, tick: sectionTickRef.current, focus: true });
    }
  }, []);

  // Round 3: triage chips (#12), eager so the overview header is honest on open.
  const [triage, setTriage] = React.useState<TriageChips | null>(null);

  // Round 3: typed ReAct timeline (#12), lazy on the Investigation tab (powers the
  // DecisionCard's policy clause and the collapsible full trace).
  const [timeline, setTimeline] = React.useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = React.useState(false);
  const [timelineError, setTimelineError] = React.useState<unknown>(null);

  // The six-stage narrative, lazy: Evidence's "What happened" (its ingestion stage) and the
  // Brief's folded "How this case was built" (every stage) read it (Round 16, D8).
  const [stages, setStages] = React.useState<TimelineStagesResponse | null>(null);
  const [storyOpen, setStoryOpen] = React.useState(false);
  const [stagesLoading, setStagesLoading] = React.useState(false);
  const [stagesError, setStagesError] = React.useState<unknown>(null);

  // Round 3: collaboration thread (#4), lazy on the Collaboration tab.
  const [thread, setThread] = React.useState<ThreadMessage[] | null>(null);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [threadError, setThreadError] = React.useState<unknown>(null);
  const [threadBusyId, setThreadBusyId] = React.useState<string | null>(null);

  // Round 3: activity (#4), lazy on the Activity tab alongside the thread. The free-form
  // tasks are on the Response tab ("Other tasks", Round 14 D36; for every viewer since
  // Round 16).
  const [activity, setActivity] = React.useState<CaseActivityItem[] | null>(null);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const [activityError, setActivityError] = React.useState<unknown>(null);

  // Users for the assignee picker + @mention autocomplete (best-effort).
  const [pickUsers, setPickUsers] = React.useState<PickableUser[]>([]);

  const { username: currentUser, hasPermission, role: viewerRole, authEnabled, rbacEnabled } = useAuth();
  const canComment = useCan('cases', 'comment');
  const canWriteCase = useCan('cases', 'write');

  // Round 15 (D6.12, D8.2): the auto-close review. Its state is read only for a case the
  // agent closed (terminal, first decision record an agent close), again after a review,
  // on a `case.review` frame the queue passes on, and when the status changes.
  const agentClosed = Boolean(c && c.case_id === id && isAgentClosedCase(c));
  const [reviewTick, setReviewTick] = React.useState(0);
  const reviewState = useCaseReviewState(
    open ? id : null,
    agentClosed,
    `${reviewRefreshKey}:${reviewTick}:${c?.status ?? ''}`,
  );
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // A new session per opening: the card measures the time from opening it.
  const [reviewSession, setReviewSession] = React.useState(0);
  const reviewOpenerRef = React.useRef<HTMLElement | null>(null);

  // Round 15 (D5.12): the Files section re-reads on a screenshot frame or an upload from
  // the close dialog; its count sits beside the section heading.
  const [filesTick, setFilesTick] = React.useState(0);
  const [filesCount, setFilesCount] = React.useState<{ count: number; max: number | null } | null>(null);
  const filesTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFiles = React.useCallback(() => {
    if (filesTimer.current) clearTimeout(filesTimer.current);
    filesTimer.current = setTimeout(() => {
      filesTimer.current = null;
      setFilesTick((n) => n + 1);
    }, FILES_REFRESH_MS);
  }, []);
  React.useEffect(
    () => () => {
      if (filesTimer.current) clearTimeout(filesTimer.current);
    },
    [],
  );

  const [rationale, setRationale] = React.useState<CaseRationale | null>(null);
  const [rationaleLoading, setRationaleLoading] = React.useState(false);
  const [rationaleError, setRationaleError] = React.useState<unknown>(null);

  // Threat context (F11): lazy.
  const [threat, setThreat] = React.useState<ThreatContextPanelData | null>(null);
  const [threatLoading, setThreatLoading] = React.useState(false);
  const [threatError, setThreatError] = React.useState<unknown>(null);

  // Round 14 (SPEC §4.10.11): the case's runbook runs, read once and shared by the
  // Runbook tab, the Overview's Next step card, the facts rail and the close dialog.
  const canReadRunbooks = hasPermission('runbooks', 'read') && hasPermission('cases', 'read');
  const canRunRunbooks = hasPermission('runbooks', 'run');
  // POST /api/cases/{id}/reinvestigate needs `cases:reinvestigate` (tier 2 and up by
  // default): without it the action, its R shortcut and its model list are not offered.
  const canReinvestigate = hasPermission('cases', 'reinvestigate');
  // A case's own AI spend follows `cost:view` like every other spend figure: without it
  // the facts rail, the Overview and the Reinvestigate dialog leave it out.
  const canViewCost = hasPermission('cost', 'view');
  // GET /api/users needs `users:manage`. Without it the owner field takes a typed name and
  // @mentions are not suggested, and the read is never sent (it could only be refused).
  const canListUsers = hasPermission('users', 'manage');
  // GET /api/settings needs `settings:read` (C60). Without it the read is never sent (each
  // refusal would write an Access denied row): the auto-close entry for the verdict and
  // the SLA reading come from the triage read, and the runbook-preference and
  // notification-channel facts are left out.
  const canReadSettings = hasPermission('settings', 'read');
  // "Open in Approvals" on an automation record needs the Approvals queue (`proposals:read`).
  const canReadProposals = hasPermission('proposals', 'read');
  // The AI investigation run on this case, if one is queued or running (WP09's store).
  const aiRun = useAiRun(open ? id : null);
  const aiRunning = aiRun !== null && aiRun.state !== 'finished';
  const runbooks = useCaseRunbooks(open ? id : null, { enabled: canReadRunbooks });
  // A deep link's tab, re-applied when the link or its case changes (closing QA integ-06).
  // The AI investigation tab's link is "Open case trace", so it also asks the panel to
  // open the trace and bring it into view: a new tick per request, kept until the panel
  // reports it handled and never replayed. The request names the linked case. The panel
  // sees it only once that case is the one on screen (below), so it never opens the trace
  // of the case being replaced, and a switch to any other case drops it.
  const requested: CaseTab | null = requestedTab;
  const [traceRequest, setTraceRequest] = React.useState<{ tick: number; caseId: string } | null>(null);
  const traceTickRef = React.useRef(0);
  // A rewritten link names a section of its tab instead (Evidence's "Threat context"), so
  // it does not also open the trace.
  React.useEffect(() => {
    if (!requested) return;
    setTab(requested);
    if (requestedSection) {
      sectionTickRef.current += 1;
      setSectionRequest({ section: requestedSection, tick: sectionTickRef.current, focus: false });
    } else if (requested === 'investigation') {
      traceTickRef.current += 1;
      setTraceRequest({ tick: traceTickRef.current, caseId: id });
    }
  }, [requested, requestedSection, id]);
  // The queue can open another case before the linked one arrives, with no tab in the
  // address: the link was for the other case's trace, so it goes with the switch and is
  // not replayed if the analyst later opens the linked case again.
  React.useEffect(() => {
    setTraceRequest((current) => (current && current.caseId !== id ? null : current));
  }, [id]);
  // An analyst who moves to another tab before the request applies has made their own
  // choice: coming back to Investigation later shows the trace as they left it.
  React.useEffect(() => {
    if (tab !== 'investigation') setTraceRequest(null);
    setSectionRequest((current) => (current && CASE_SECTIONS[current.section] !== tab ? null : current));
  }, [tab]);
  // Bring the requested section into view once its tab is on screen, then forget it. The
  // sections above it fill in after the first paint (the runbook's Next step card, the
  // summary, the AI assessment), so the section is HELD at the top of the lane while the
  // content settles (SECTION_HOLD_MS), and let go at once when the analyst scrolls, clicks
  // or types in the lane: a late load never leaves the link above its section.
  const caseShown = Boolean(c);
  React.useEffect(() => {
    if (!sectionRequest || !caseShown || CASE_SECTIONS[sectionRequest.section] !== tab) return undefined;
    const { section, tick, focus } = sectionRequest;
    const lane = panelScrollRef.current;
    if (!lane) return undefined;
    let placed = false;
    let observer: ResizeObserver | null = null;
    let holdTimer: number | undefined;
    // Where the lane was last sent: a smooth scroll still on its way there is left alone.
    let sentTo = -1;
    const align = (smooth: boolean): boolean => {
      const target = lane.querySelector<HTMLElement>(`[data-section="${section}"]`);
      if (!target) return false;
      const top = Math.max(0, lane.scrollTop + target.getBoundingClientRect().top - lane.getBoundingClientRect().top);
      if (Math.abs(top - lane.scrollTop) < 1 || Math.abs(top - sentTo) < 1) return true;
      sentTo = top;
      if (typeof lane.scrollTo === 'function') lane.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      else lane.scrollTop = top;
      return true;
    };
    let removeListeners = () => {};
    const release = () => {
      observer?.disconnect();
      observer = null;
      window.clearTimeout(holdTimer);
      removeListeners();
      setSectionRequest((current) => (current?.tick === tick ? null : current));
    };
    const place = () => {
      if (!align(!placed && !reduceMotion)) return;
      if (!placed) {
        placed = true;
        if (focus) lane.querySelector<HTMLElement>(`[data-section="${section}"] [data-section-title]`)?.focus({ preventScroll: true });
      }
    };
    const frame = window.requestAnimationFrame(() => {
      place();
      // Content above (or the section itself, still loading) changing size re-places it.
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => place());
        for (const child of Array.from(lane.children)) observer.observe(child);
      }
      // The analyst took over the lane: the request is done.
      const onIntent = () => release();
      for (const type of SECTION_HOLD_RELEASE) lane.addEventListener(type, onIntent, { passive: true });
      removeListeners = () => {
        for (const type of SECTION_HOLD_RELEASE) lane.removeEventListener(type, onIntent);
      };
      holdTimer = window.setTimeout(() => {
        place();
        release();
      }, SECTION_HOLD_MS);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.clearTimeout(holdTimer);
      removeListeners();
    };
  }, [sectionRequest, caseShown, tab, reduceMotion]);
  const traceRequestHandled = React.useCallback((tick: number) => {
    setTraceRequest((current) => (current?.tick === tick ? null : current));
  }, []);
  const [runbookPrefs, setRunbookPrefs] = React.useState<RunbookPrefs>(DEFAULT_RUNBOOK_PREFS);
  const [runbookRequest, setRunbookRequest] = React.useState<RunbookFocusRequest | null>(null);
  // Every request gets a new tick (never reused after one is forgotten), and the Runbook
  // tab reports each one handled, so returning to the tab never replays it.
  const runbookTickRef = React.useRef(0);
  const requestRunbook = React.useCallback((request: RunbookRequestKind | null) => {
    setTab('runbook');
    if (request) {
      runbookTickRef.current += 1;
      setRunbookRequest({ ...request, tick: runbookTickRef.current } as RunbookFocusRequest);
    }
  }, []);
  const runbookRequestHandled = React.useCallback((tick: number) => {
    setRunbookRequest((current) => (current?.tick === tick ? null : current));
  }, []);
  const runbookViewer = React.useMemo(
    () => ({ role: viewerRole ?? null, unrestricted: !authEnabled || !rbacEnabled }),
    [viewerRole, authEnabled, rbacEnabled],
  );
  // The open required steps a close dialog asks about: from the loaded runs, or from a
  // `409 runbook_steps_open` when the runs changed since they were read.
  const [refusedSteps, setRefusedSteps] = React.useState<RunbookStepsOpen[] | null>(null);
  const [openStepsReason, setOpenStepsReason] = React.useState('');
  const [openStepsError, setOpenStepsError] = React.useState<string | null>(null);

  // The header's Take action menu (every verb but the primary, the investigation tools,
  // export and notify), the same in both hosts.
  const [takeActionOpen, setTakeActionOpen] = React.useState(false);

  // Pending lifecycle action (confirm dialog) + optional structured fields.
  const [pending, setPending] = React.useState<ActionDef | null>(null);
  const [note, setNote] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [actionAssignee, setActionAssignee] = React.useState('');
  // Round 15 (D4.2): what the person did about the case (fixed vocabulary). Tags left the
  // dialog for the facts rail and the Resolution select left with the duplicate question
  // (D4.1, D4.6).
  const [actionsTaken, setActionsTaken] = React.useState<WireActionTaken[]>([]);
  const [actionDisposition, setActionDisposition] = React.useState('');
  // GROUND-TRUTH INTENT (G1). True only once the ANALYST has operated the disposition
  // picker in this dialog. `actionDisposition` alone cannot carry that fact: the value
  // stored on a case is routinely the one `case_manager.apply()` derived from the LLM
  // verdict, so posting it back would quote the model to itself and the backend would
  // record the model's guess as analyst-confirmed evidence. This flag is what the wire
  // sends as `disposition_declared`; the picker's onChange is its ONLY writer.
  const [dispositionDeclared, setDispositionDeclared] = React.useState(false);
  const declareDisposition = React.useCallback((v: string) => {
    setActionDisposition(v);
    setDispositionDeclared(Boolean(v));
  }, []);
  const [actionReason, setActionReason] = React.useState('');
  // Round-7 #10 (feedback-into-close): the in-dialog AI-decision grading draft. Grading
  // actions (close / confirm-FP / resolve / set-disposition) POST it as a SEPARATE
  // `caseFeedback` call after the deterministic close: never through `decide()` (#3).
  const [grading, setGrading] = React.useState<GradingDraft>(emptyGradingDraft());
  const [acting, setActing] = React.useState(false);

  // Reinvestigate (the dialog is `ReinvestigateDialog`, which WP09 makes non-blocking).
  const [reinvestOpen, setReinvestOpen] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);

  // Export.
  const [exporting, setExporting] = React.useState<'json' | 'md' | null>(null);

  // The auto-close policy `decide()` acts on (`prefs.auto_close`, B27), when the settings
  // were read; the deprecated `prefs.fp_auto_close` is never read.
  const [autoClosePolicy, setAutoClosePolicy] = React.useState<AutoClosePolicy | null>(null);
  // From the triage read (C60): the auto-close entry for the case's verdict and the SLA
  // reading, for a viewer who may not read the settings (and as the SLA's first source).
  const [triagePolicy, setTriagePolicy] = React.useState<FpPolicy>(null);
  const [serverSla, setServerSla] = React.useState<SlaReadingWire | null>(null);
  // Today's internal network range that holds the entity, sent only to a person who may
  // read the settings (WP10), for the risk explanation.
  const [assetRange, setAssetRange] = React.useState<AssetRangeReading | null>(null);
  // SLA policy for the header's advisory SLA reading (best-effort, #3-safe).
  const [slaPolicy, setSlaPolicy] = React.useState<SlaPolicy | null>(null);
  // Header popovers + the narrow-pane inspector sheet (keyboard shortcuts open them).
  const [ownerOpen, setOwnerOpen] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const detailsTitleRef = React.useRef<HTMLHeadingElement | null>(null);
  // The inspector column (Round 16, [cmux] §5.6): beside the tabs from a 52rem pane, shown
  // or hidden with `]` or the header's toggle, and kept per viewer. `columnFits` follows the
  // container query (a zero-size probe that the same query shows), so the toggle knows
  // whether it toggles the column or opens the sheet.
  const [inspectorOpen, setInspectorOpenState] = React.useState<boolean>(() => readInspectorOpen());
  const setInspectorOpen = React.useCallback((next: boolean) => {
    setInspectorOpenState(next);
    writeInspectorOpen(next);
  }, []);
  const [columnFits, setColumnFits] = React.useState(true);
  const probeRef = React.useRef<HTMLSpanElement | null>(null);
  const tabsRootRef = React.useRef<HTMLDivElement | null>(null);
  // The tag editor lives in the inspector (Round 15, D8.2): in the column beside the tabs,
  // or in the sheet when the pane is too narrow for the column. T and "Edit tags" open it
  // where the inspector is; a hidden column that fits opens first, and with no room for
  // the column the sheet opens first and the editor once the sheet is up.
  const [tagsEditor, setTagsEditor] = React.useState<'column' | 'sheet' | null>(null);
  const railColumnRef = React.useRef<HTMLDivElement | null>(null);
  const tagsInSheetRef = React.useRef(false);
  // The sheet was closed by a link that moves focus itself (the related cases): its close
  // then leaves focus where that link put it, instead of on the toggle.
  const sheetLeavesFocusRef = React.useRef(false);
  const inspectorOpenRef = React.useRef(inspectorOpen);
  inspectorOpenRef.current = inspectorOpen;
  const openTagsEditor = React.useCallback(() => {
    const column = railColumnRef.current;
    if (column && elementShown(column)) {
      setTagsEditor('column');
      return;
    }
    const probe = probeRef.current;
    if (!inspectorOpenRef.current && probe && elementShown(probe)) {
      setInspectorOpen(true);
      setTagsEditor('column');
      return;
    }
    tagsInSheetRef.current = true;
    setDetailsOpen(true);
  }, [setInspectorOpen]);
  // The control that opened a lifecycle / editor dialog, so focus returns to it (CM-3).
  const actionOpenerRef = React.useRef<HTMLElement | null>(null);
  const takeActionTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  // B28: an editor chosen in Take action opens only once the menu has closed. The menu
  // gave focus back to its trigger as it closed, and the non-modal owner popover or tag
  // editor dismissed itself on that focus move.
  const pendingMenuEditorRef = React.useRef<'owner' | 'tags' | null>(null);
  // A finding's "Cites N events" narrows Evidence's events to them (cleared by the table).
  const [eventFilter, setEventFilter] = React.useState<string[] | null>(null);
  // The Decision lane's "Policy inputs" reads the trace: it loads when they open.
  const [timelineWanted, setTimelineWanted] = React.useState(false);
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);

  // Notify (manual send): F5/Wave 4. Channels come from the loaded settings.
  const [notifyOpen, setNotifyOpen] = React.useState(false);
  const [notifyChannels, setNotifyChannels] = React.useState<NotifyChannelOption[]>([]);
  const [notifyEnabled, setNotifyEnabled] = React.useState(false);
  const [notifyChannelId, setNotifyChannelId] = React.useState<string>('');
  const [notifying, setNotifying] = React.useState(false);

  const loadCase = React.useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCase(id);
      if (activeIdRef.current !== id) return; // a newer case is loading: drop the stale result
      commitCase(res);
    } catch (e) {
      if (activeIdRef.current !== id) return;
      setError(e);
    } finally {
      if (activeIdRef.current === id) setLoading(false);
    }
  }, [id, commitCase]);

  // The caller's copy of the case (the queue row), read through a ref so a parent
  // re-render with a fresh row object never re-runs the reset below.
  const previewRef = React.useRef<Case | null>(previewCase);
  previewRef.current = previewCase;

  React.useEffect(() => {
    if (!open) return;
    // Reset all per-case lazy state when the case changes / opens. The case itself is
    // NOT blanked (CM-5): the caller's preview renders at once when it matches, and
    // otherwise the previous case stays on screen, dimmed under a progress bar, until
    // the new one arrives. Actions stay disabled while the shown case is not `id`.
    //
    // Each lazy read's loading flag is cleared with its data and error. A read still
    // running for the case being replaced is dropped when it lands (its id no longer
    // matches), so it never clears its own flag: left set, the flag would hold off this
    // case's read on its tab for good and keep the panel loading.
    const preview = previewRef.current;
    if (preview && preview.case_id === id) setC(preview);
    setRationale(null);
    setRationaleError(null);
    setRationaleLoading(false);
    setTriage(null);
    setTimeline(null);
    setTimelineError(null);
    setTimelineLoading(false);
    setStages(null);
    setStagesError(null);
    setStagesLoading(false);
    setThread(null);
    setThreadError(null);
    setThreadLoading(false);
    setThreadBusyId(null);
    setRunbookRequest(null);
    setRefusedSteps(null);
    setActivity(null);
    setActivityLoading(false);
    setActivityError(null);
    // Threat context is lazy-loaded and guarded by `threat === null`; resetting it
    // (and its error) here is what makes Investigation's Threat context refetch for the
    // newly-opened case instead of showing the previous case's IOC/MITRE data.
    setThreat(null);
    setThreatError(null);
    setThreatLoading(false);
    setTriagePolicy(null);
    setServerSla(null);
    setAssetRange(null);
    setEventFilter(null);
    setTimelineWanted(false);
    // A review belongs to the case it was opened on; the Files count is read again.
    setReviewOpen(false);
    setFilesCount(null);
    // The active tab is kept across case switches: an analyst browsing the queue on
    // AI investigation stays on AI investigation (Defender's Up/Down behaviour).
    void loadCase();
  }, [open, id, loadCase]);

  // Triage chips (#12), eager so the inspector's Signal section reflects the four honest
  // signals as soon as the case opens. Best-effort: a failure leaves the chips null and
  // the inspector falls back to the case's own fields. The same read carries the
  // auto-close entry for the verdict and the SLA reading (C60, WP10), read defensively.
  const loadTriage = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    try {
      const res = await getTriage(id);
      if (activeIdRef.current !== id) return;
      setTriage(res?.chips || null);
      setTriagePolicy(triageAutoClosePolicy(res));
      setServerSla(triageSla(res));
      setAssetRange(triageAssetCidr(res));
    } catch {
      if (activeIdRef.current === id) setTriage(null);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && id) void loadTriage();
  }, [open, id, loadTriage]);

  // Campaign membership (#51): fetch the campaign this case belongs to, keyed on the
  // open case. Fail-open: a disabled/absent campaigns feature (or any error) simply
  // clears the chip. Reset to null immediately so a newly-opened case never shows the
  // previous case's campaign while the fetch is in flight. Wrapped in try/catch so a
  // synchronous stub failure is handled the same as a rejection.
  React.useEffect(() => {
    setCampaign(null);
    if (!(open && id)) return;
    let alive = true;
    void (async () => {
      try {
        const res = await campaignsApi.forCase(id);
        if (alive) setCampaign(res.campaign);
      } catch {
        if (alive) setCampaign(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, id]);

  // Users for the picker + @mention autocomplete (best-effort, once per open), only for a
  // viewer who may list users.
  React.useEffect(() => {
    if (!open) return;
    if (!canListUsers) {
      setPickUsers([]);
      return;
    }
    let cancelled = false;
    void listPickableUsers().then((res) => {
      if (!cancelled) setPickUsers(res);
    });
    return () => {
      cancelled = true;
    };
  }, [open, canListUsers]);

  // Typed ReAct timeline (#12): lazy on the AI investigation tab and the Brief's policy inputs.
  const loadTimeline = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const res = await getTimeline(id);
      if (activeIdRef.current !== id) return;
      setTimeline(res);
    } catch (e) {
      if (activeIdRef.current === id) setTimelineError(e);
    } finally {
      if (activeIdRef.current === id) setTimelineLoading(false);
    }
  }, [id]);

  // Lazy on the AI investigation tab, and once the Brief's "Policy inputs" open.
  // `!timelineError` in the guard stops a failed fetch from re-firing forever (the loading
  // flag flips back to false on failure, which would otherwise re-satisfy
  // `timeline === null && !loading` and hammer the backend). The Retry affordance still
  // works: loadTimeline clears the error before refetching.
  const wantsTimeline = tab === 'investigation' || (tab === 'overview' && timelineWanted);
  React.useEffect(() => {
    if (open && wantsTimeline && timeline === null && !timelineLoading && !timelineError) {
      void loadTimeline();
    }
  }, [open, wantsTimeline, timeline, timelineLoading, timelineError, loadTimeline]);

  // While an AI run is under way the open trace follows it (XFCM). A quiet re-read keeps
  // the shown trace on screen (no skeleton, no error state), and a failed read keeps the
  // last good trace. It runs only once a trace is loaded: the lazy load above does the
  // first read. Its triggers: an `agent.step` or `case.investigation` frame for this case
  // on the page's one event stream (frames within TRACE_REFRESH_MS share one re-read; a
  // frame is never rendered, #9), a change of the run's phase, a poll every TRACE_POLL_MS
  // for as long as the run is under way, and the run's end, whatever its outcome. The poll
  // runs even while the stream is live: the pipeline sends its `agent.step` frames when a
  // run starts (triage, specialist, evidence) and when it decides, and none while the
  // investigator works, so frames alone leave the trace still for most of a run.
  const timelineShownRef = React.useRef(false);
  React.useEffect(() => {
    timelineShownRef.current = timeline !== null;
  }, [timeline]);
  const refreshTimelineQuietly = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id || !timelineShownRef.current) return;
    try {
      const res = await getTimeline(id);
      if (activeIdRef.current === id && timelineShownRef.current) setTimeline(res);
    } catch {
      // Keep the trace already on screen; the next frame, poll or the run's end reads again.
    }
  }, [id]);
  const traceFollowsRun = open && aiRunning && wantsTimeline && timeline !== null;
  const traceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTraceFrame = React.useCallback(
    (event: StreamEvent) => {
      if (event.type !== AGENT_STEP_CHANNEL && event.type !== 'case.investigation') return;
      // The page's stream hands this hook only this case's frames; checked here as well.
      const frameCase = (event.data as { case_id?: unknown } | null)?.case_id;
      if (frameCase !== id || traceTimer.current) return;
      traceTimer.current = setTimeout(() => {
        traceTimer.current = null;
        void refreshTimelineQuietly();
      }, TRACE_REFRESH_MS);
    },
    [id, refreshTimelineQuietly],
  );
  useEventStream(traceFollowsRun && id ? [`cases:${id}`] : [], {
    enabled: traceFollowsRun,
    onEvent: onTraceFrame,
  });
  React.useEffect(
    () => () => {
      if (traceTimer.current) clearTimeout(traceTimer.current);
      traceTimer.current = null;
    },
    [id],
  );
  // A change of the run's phase (the investigation store reads it from the route).
  const runPhase = aiRunning ? (aiRun?.phase ?? null) : null;
  const lastRunPhase = React.useRef<string | null>(null);
  React.useEffect(() => {
    const before = lastRunPhase.current;
    lastRunPhase.current = runPhase;
    if (traceFollowsRun && runPhase && before && before !== runPhase) void refreshTimelineQuietly();
  }, [runPhase, traceFollowsRun, refreshTimelineQuietly]);
  // The poll for as long as the run is under way, live stream or not (see above).
  React.useEffect(() => {
    if (!traceFollowsRun) return undefined;
    const timer = window.setInterval(() => void refreshTimelineQuietly(), TRACE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [traceFollowsRun, refreshTimelineQuietly]);
  // The run's end, whatever its outcome: a failed or timed-out run never leaves a half-way
  // trace (a decided run's case is also read again by the Reinvestigate dialog).
  const lastRunning = React.useRef<{ id: string | null; running: boolean }>({ id: null, running: false });
  React.useEffect(() => {
    const before = lastRunning.current;
    lastRunning.current = { id: id ?? null, running: aiRunning };
    if (open && before.id === (id ?? null) && before.running && !aiRunning) void refreshTimelineQuietly();
  }, [id, open, aiRunning, refreshTimelineQuietly]);

  const loadStages = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    setStagesLoading(true);
    setStagesError(null);
    try {
      const res = await getCaseStages(id);
      if (activeIdRef.current !== id) return;
      setStages(res);
    } catch (e) {
      if (activeIdRef.current === id) setStagesError(e);
    } finally {
      if (activeIdRef.current === id) setStagesLoading(false);
    }
  }, [id]);

  // Lazy on the Evidence tab (its "What happened") and while the Brief's "How this case
  // was built" is open (same error-guard rationale as loadTimeline above).
  const wantsStages = tab === 'evidence' || (tab === 'overview' && storyOpen);
  React.useEffect(() => {
    if (open && wantsStages && stages === null && !stagesLoading && !stagesError) {
      void loadStages();
    }
  }, [open, wantsStages, stages, stagesLoading, stagesError, loadStages]);

  // ---- Activity: thread + activity (#4) --------------------------------- //
  const loadThread = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    setThreadLoading(true);
    setThreadError(null);
    try {
      const res = await getThread(id);
      if (activeIdRef.current !== id) return;
      setThread(res.messages || []);
    } catch (e) {
      // Preserve an already-loaded authoritative discussion snapshot when a live or
      // mutation-triggered refresh fails. `thread === null` still denotes an initial
      // load failure; a non-null thread lets the panel render stale-but-truthful data
      // beside an explicit refresh error and retry affordance.
      if (activeIdRef.current === id) setThreadError(e);
    } finally {
      if (activeIdRef.current === id) setThreadLoading(false);
    }
  }, [id]);

  const loadActivity = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    setActivityLoading(true);
    setActivityError(null);
    try {
      const res = await getActivity(id);
      if (activeIdRef.current !== id) return;
      setActivity(res.activity || []);
    } catch (e) {
      // Same truth contract as tasks: never turn transport failure into "No activity";
      // preserve the last good feed during refresh and expose the failure independently.
      if (activeIdRef.current === id) setActivityError(e);
    } finally {
      if (activeIdRef.current === id) setActivityLoading(false);
    }
  }, [id]);

  // LIVE (Wave 4) refetch nudges. A `case.activity` SSE frame (only while realtime is
  // enabled AND the thread tab is mounted) asks us to refetch the AUTHORITATIVE thread
  // / activity feed: the frame payload is never rendered (#9), it only triggers a
  // reload, and nothing here touches the case decision (#3). Trailing-debounced so a
  // burst of teammate/AI events collapses into one refetch instead of a fetch storm.
  const liveThreadTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveActivityTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshThread = React.useCallback(
    (event?: StreamEvent) => {
      // A frame that names a screenshot (Round 15, D5.12) re-reads the Files section; the
      // thread did not change. Only the id's presence is read, never a value (#9).
      const ref = (event?.data as { ref?: { file_id?: unknown } } | null | undefined)?.ref;
      if (ref && typeof ref.file_id === 'string') {
        refreshFiles();
        return;
      }
      if (liveThreadTimer.current) clearTimeout(liveThreadTimer.current);
      liveThreadTimer.current = setTimeout(() => {
        void loadThread();
      }, 1200);
    },
    [loadThread, refreshFiles],
  );
  const liveRefreshActivity = React.useCallback(() => {
    if (liveActivityTimer.current) clearTimeout(liveActivityTimer.current);
    liveActivityTimer.current = setTimeout(() => {
      void loadActivity();
    }, 1200);
  }, [loadActivity]);
  React.useEffect(
    () => () => {
      if (liveThreadTimer.current) clearTimeout(liveThreadTimer.current);
      if (liveActivityTimer.current) clearTimeout(liveActivityTimer.current);
    },
    [],
  );

  React.useEffect(() => {
    if (open && tab === 'collab') {
      // `!threadError` stops a failed thread fetch from re-firing forever (Retry still
      // works: each loader clears its own error before refetching). The independent
      // activity guard prevents a failed endpoint from retry-looping or hiding the
      // other collaboration surface.
      if (thread === null && !threadLoading && !threadError) void loadThread();
      if (activity === null && !activityLoading && !activityError) void loadActivity();
    }
  }, [
    open,
    tab,
    thread,
    threadLoading,
    threadError,
    activity,
    activityLoading,
    activityError,
    loadThread,
    loadActivity,
  ]);

  // Thread mutation handlers: each calls the API then refreshes the thread +
  // activity (so an @mention/new event shows). #3-safe: posting never touches the
  // case decision (the backend enforces this). One that lands after the queue moved on
  // refreshes nothing (the loaders start only for the case on screen) and leaves the
  // busy marker alone: the switch already cleared it, and it may now be the next
  // case's own post.
  const postMessage = React.useCallback(
    async (text: string, parentId?: string) => {
      if (!id) return;
      setThreadBusyId(parentId || '__post__');
      try {
        await postThread(id, { body: text, parent_id: parentId ?? null });
        await loadThread();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not post the message.');
      } finally {
        if (activeIdRef.current === id) setThreadBusyId(null);
      }
    },
    [id, loadThread, loadActivity],
  );

  const editMessage = React.useCallback(
    async (msgId: string, text: string) => {
      if (!id) return;
      setThreadBusyId(msgId);
      try {
        await editThreadMessage(id, msgId, text);
        await loadThread();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not edit the message.');
      } finally {
        if (activeIdRef.current === id) setThreadBusyId(null);
      }
    },
    [id, loadThread],
  );

  const removeMessage = React.useCallback(
    async (msgId: string) => {
      if (!id) return;
      setThreadBusyId(msgId);
      try {
        await deleteThreadMessage(id, msgId);
        await loadThread();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not delete the message.');
      } finally {
        if (activeIdRef.current === id) setThreadBusyId(null);
      }
    },
    [id, loadThread, loadActivity],
  );

  const reactMessage = React.useCallback(
    async (msgId: string, emoji: string, remove: boolean) => {
      if (!id) return;
      setThreadBusyId(msgId);
      try {
        await reactThreadMessage(id, msgId, emoji, remove);
        await loadThread();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not react.');
      } finally {
        if (activeIdRef.current === id) setThreadBusyId(null);
      }
    },
    [id, loadThread],
  );

  const loadRationale = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    setRationaleLoading(true);
    setRationaleError(null);
    try {
      const res = await api.caseRationale(id);
      if (activeIdRef.current !== id) return;
      setRationale(res);
    } catch (e) {
      if (activeIdRef.current === id) setRationaleError(e);
    } finally {
      if (activeIdRef.current === id) setRationaleLoading(false);
    }
  }, [id]);

  // The Brief's AI lane and the AI investigation's assessment read the model's reasoning,
  // so it loads with either tab (and at once in Case Manager).
  React.useEffect(() => {
    const needsRationale = tab === 'investigation' || tab === 'overview' || presentation === 'embedded';
    if (open && needsRationale && rationale === null && !rationaleLoading && !rationaleError) {
      void loadRationale();
    }
  }, [open, tab, presentation, rationale, rationaleLoading, rationaleError, loadRationale]);

  const loadThreat = React.useCallback(async () => {
    if (!id || activeIdRef.current !== id) return;
    setThreatLoading(true);
    setThreatError(null);
    try {
      const res = await api.cases.threatContext(id);
      if (activeIdRef.current !== id) return;
      setThreat(res);
    } catch (e) {
      if (activeIdRef.current === id) setThreatError(e);
    } finally {
      if (activeIdRef.current === id) setThreatLoading(false);
    }
  }, [id]);

  // Lazy on the Evidence tab, whose "Threat context" section it is (Round 16, D8).
  React.useEffect(() => {
    if (open && tab === 'evidence' && threat === null && !threatLoading && !threatError) {
      void loadThreat();
    }
  }, [open, tab, threat, threatLoading, threatError, loadThreat]);

  // Round 14: a case change can attach a runbook (a status move, a reinvestigation, new
  // tags re-evaluate the match, §4.10.4), so the runs are read again when the case on
  // screen changes, and whenever the Response tab opens.
  const { refresh: refreshRunbooks } = runbooks;
  const caseStamp = c && c.case_id === id ? `${c.updated_at ?? ''}|${c.status ?? ''}|${(c.tags ?? []).length}` : '';
  const seenStamp = React.useRef('');
  React.useEffect(() => {
    if (!caseStamp || !canReadRunbooks) return;
    const first = !seenStamp.current || !seenStamp.current.startsWith(`${id}::`);
    const key = `${id}::${caseStamp}`;
    if (seenStamp.current === key) return;
    seenStamp.current = key;
    if (!first) void refreshRunbooks();
  }, [caseStamp, id, canReadRunbooks, refreshRunbooks]);
  React.useEffect(() => {
    if (open && tab === 'runbook' && canReadRunbooks) void refreshRunbooks();
  }, [open, tab, canReadRunbooks, refreshRunbooks]);

  // Models for the reinvestigate picker (best-effort), read only when it can be used.
  React.useEffect(() => {
    if (!open || !canReinvestigate) return;
    let cancelled = false;
    void api
      .getModels()
      .then((res) => {
        if (!cancelled) setModels(res);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, canReinvestigate]);

  // The settings the case surfaces read (best-effort), only for a holder of
  // `settings:read` (C60): the auto-close policy `decide()` acts on (B27), the SLA policy,
  // the runbook preferences and the notification channels.
  React.useEffect(() => {
    if (!open || !canReadSettings) return;
    let cancelled = false;
    void api
      .getSettings()
      .then((res) => {
        if (cancelled) return;
        const policy = res?.prefs?.auto_close;
        setAutoClosePolicy(policy && typeof policy === 'object' ? (policy as AutoClosePolicy) : null);
        setSlaPolicy((res?.prefs?.sla as SlaPolicy | undefined) ?? null);
        setRunbookPrefs(readRunbookPrefs(res?.prefs));
        const notif = res?.prefs?.notifications;
        setNotifyEnabled(Boolean(notif?.enabled));
        const chans = (notif?.channels || []).map((c) => ({
          id: c.id,
          type: String(c.type),
          name: c.name || c.id,
          enabled: Boolean(c.enabled),
        }));
        setNotifyChannels(chans);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, canReadSettings]);

  const runNotify = React.useCallback(async () => {
    setNotifying(true);
    try {
      const res = await api.cases.notify(id, notifyChannelId || undefined);
      // The service's own "dispatch" result is not a channel (notifyResult.ts).
      const outcome = notifyResultToast(res.sent);
      toast[outcome.kind](outcome.text);
      setNotifyOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send notification.');
    } finally {
      setNotifying(false);
    }
  }, [id, notifyChannelId]);

  const resetActionFields = React.useCallback(() => {
    setNote('');
    setPriority('');
    setActionAssignee('');
    setActionsTaken([]);
    setActionDisposition('');
    setDispositionDeclared(false);
    setActionReason('');
    setGrading(emptyGradingDraft());
    setOpenStepsReason('');
    setOpenStepsError(null);
    setRefusedSteps(null);
  }, []);

  const openAction = React.useCallback(
    (a: ActionDef) => {
      setTakeActionOpen(false);
      resetActionFields();
      // The disposition picker opens EMPTY, deliberately (G1).
      //
      // It used to be pre-seeded from `c.disposition`. But that value is normally the
      // one `case_manager.apply()` mapped from the LLM verdict, so the pre-seed both
      // satisfied the dialog's "a disposition is mandatory" guard on the analyst's
      // behalf and posted the model's own answer back as if a human had given it. An
      // empty picker makes that guard real: the primary Close stays disabled until
      // someone actually chooses an outcome, and only then does the wire assert
      // `disposition_declared`. The value is not hidden: the dialog shows it as
      // read-only "Currently recorded" context under the picker (and the case page
      // keeps its disposition badge): it is just no longer pre-filled into the
      // analyst's answer.
      setPending(a);
    },
    [resetActionFields],
  );

  const closeAction = React.useCallback(() => {
    setPending(null);
    resetActionFields();
  }, [resetActionFields]);

  const runAction = React.useCallback(async (andNext = false) => {
    if (!pending) return;
    setActing(true);
    try {
      // Always POST an EXISTING backend verb: `close_disposition` maps to `close`
      // via wireAction, so the server still runs the real decide()/apply() (#3).
      const input: CaseActionInput = { action: pending.wireAction ?? pending.key };
      const trimmedNote = note.trim();
      // D4.3: a disposition that overrides the AI verdict needs a note (the dialog asks for
      // it; this is the same rule, so a submit without one never posts).
      if (
        pending.fields.includes('disposition') &&
        !trimmedNote &&
        requiresDisagreementNote(c?.verdict ?? null, actionDisposition)
      ) {
        setActing(false);
        return;
      }
      if (trimmedNote) input.note = trimmedNote;
      if (pending.fields.includes('assignee') && actionAssignee.trim()) {
        input.assignee = actionAssignee.trim();
      }
      if (pending.fields.includes('priority') && priority) input.priority = priority;
      if (pending.fields.includes('actions_taken') && actionsTaken.length) {
        input.actions_taken = Array.from(new Set(actionsTaken));
      }
      if (pending.fields.includes('disposition') && actionDisposition) {
        input.disposition = actionDisposition;
        // Assert the INTENT separately from the value (G1). The backend applies the
        // disposition either way, but records it as independent analyst evidence only
        // on this flag, so a client that echoes a stored, model-derived disposition
        // cannot manufacture ground truth. Sent only when the analyst operated the
        // picker in this dialog.
        if (dispositionDeclared) input.disposition_declared = true;
      }
      if (pending.fields.includes('reason') && actionReason.trim()) {
        input.reason = actionReason.trim();
      }
      // Round 14 (D34): closing by hand never blocks, but the Console asks why when an
      // active runbook still has required steps open. It sends
      // `require_open_steps_reason` so the server answers 409 (with the steps) when the
      // runs changed since they were read; the reason is audited on
      // `case.closed_with_open_steps`. Marking a duplicate needs no reason.
      if (isTerminalVerb(pending.wireAction ?? pending.key, input.status) && !caseIsTerminal(c?.status)) {
        input.require_open_steps_reason = true;
        const reason = openStepsReason.trim();
        if (reason) input.open_steps_reason = reason;
        const asked = refusedSteps ? refusedSteps.length > 0 : openRequiredSteps(runbooks.data).length > 0;
        if (asked && !reason && actionDisposition !== 'duplicate') {
          setOpenStepsError('Say why you are closing with required steps open.');
          setActing(false);
          return;
        }
      }
      const next = await api.caseActionExec(id, input);
      commitCase(next);
      setPending(null);
      resetActionFields();
      // Completion feedback names the outcome that was recorded (Apple §16). A close or
      // resolve offers REOPEN for 8 s: the existing `reopen` analyst verb (#3). It is
      // deliberately not called Undo: a reopen keeps the classification the analyst just
      // recorded (it stays the case's analyst outcome, and the resolved-case precedent
      // written at close stays too) until the case is closed again with a new one. The
      // toast says so, so a misclick is fixed by reopening AND re-closing correctly.
      if (pending.fields.includes('disposition') && actionDisposition) {
        const verb = (pending.wireAction ?? pending.key) === 'resolve' ? 'Resolved' : 'Closed';
        if (pending.key === 'set_disposition') {
          toast.success(`Recorded as ${humanizeToken(actionDisposition).toLowerCase()}.`);
        } else {
          const closedId = id;
          const canReopen = hasPermission(ACTION_PERMISSION.reopen.resource, ACTION_PERMISSION.reopen.action);
          toast.success(`${verb} as ${humanizeToken(actionDisposition).toLowerCase()}.`, {
            duration: 8000,
            ...(canReopen
              ? {
                  description:
                    'Reopening keeps this outcome on record until you close the case again with a new one.',
                  action: {
                    label: 'Reopen',
                    onClick: () => {
                      void api
                        .caseActionExec(closedId, {
                          action: 'reopen',
                          note: 'Reopened from the close confirmation right after it was closed.',
                        })
                        .then((reopened) => {
                          // Sync the queue always; the detail only if it still shows this case.
                          if (activeIdRef.current === closedId) commitCase(reopened);
                          else onCaseChange?.(reopened);
                          toast.success('Reopened. The recorded outcome stays until you close it again.');
                        })
                        .catch((err: unknown) => {
                          toast.error(errorMessage(err, 'The case could not be reopened.'));
                        });
                    },
                  },
                }
              : {}),
          });
        }
      }
      if (andNext && onAdvance) onAdvance();
      setRationale(null);
      setTimeline(null);
      setStages(null);
      // A lifecycle action re-derives the chips + leaves an activity row.
      void loadTriage();
      if (activity !== null) void loadActivity();

      // Feedback-into-close (#10, D4.4 keeps today's rule): grading the AI decision is a
      // SEPARATE, best-effort POST from the deterministic close above; decide()/apply()
      // ran ONLY inside `caseActionExec` (two distinct calls, #3). It fires for a grading
      // action on a case that carried an AI verdict: the assessment DERIVED from the
      // disposition against the verdict (a match or an override posts one feedback entry,
      // with or without stars), or any rating the analyst gave in "Rate the AI". It never
      // carries `actual_outcome`: the declared disposition already labels the case. The
      // typeof-guard keeps callers/tests that don't wire `caseFeedback` working, and a
      // rejected grading never surfaces as a close failure.
      const gradedVerdictRaw = next.verdict ?? c?.verdict ?? '';
      const gradedVerdict = String(gradedVerdictRaw).trim().toLowerCase();
      if (
        pending.fields.includes('grading') &&
        gradedVerdict &&
        gradedVerdict !== 'none' &&
        typeof api.caseFeedback === 'function'
      ) {
        // Derive the agree/override assessment AT SUBMIT TIME from the disposition being
        // committed against the AI verdict; the dialog never asks it, so nothing stale
        // can be posted into the AI-eval loop.
        const derived = deriveAgreement(gradedVerdictRaw, actionDisposition);
        // Only a match or an override is an agreement signal. A Needs-human hand-off the
        // analyst settled (`resolved`) or an outcome with no comparison (`none`) states no
        // agreement, so nothing is posted unless the analyst entered a grade themselves:
        // otherwise every settled hand-off would count as "agree" in the Agreement metric.
        const freshAssessment =
          derived.kind === 'match' || derived.kind === 'override' ? derived.assessment : undefined;
        const gradedDraft: GradingDraft = { ...grading, assessment: freshAssessment };
        const feedbackBody = gradingToFeedbackInput(gradedDraft, currentUser || undefined);
        if (freshAssessment || isGradingDirty(gradedDraft)) {
          void api
          .caseFeedback(id, feedbackBody)
          .then((updated) => {
            // Reflect the just-recorded grading in the prior-gradings history, but only
            // if this CaseDetail is still showing the same case.
            if (updated && activeIdRef.current === id) commitCase(updated);
          })
          .catch((err: unknown) => {
            // Grading stays best-effort: the close already SUCCEEDED in a separate
            // call, so this must never be reported as a close failure (#3) and the
            // catch stays in place for genuine transport faults. But it must not be
            // SILENT either: this handler used to discard the result outright, so a
            // 422 rejecting the grading was invisible and the analyst walked away
            // believing their ground truth had been recorded.
            const rejected = err instanceof ApiError && err.status >= 400 && err.status < 500;
            const detail = errorMessage(err, 'the grading was not recorded');
            if (rejected) {
              toast.error(`Case updated, but the grading was rejected: ${detail}`);
            } else {
              toast.warning(`Case updated, but the grading was not recorded: ${detail}`);
            }
          });
        }
      }
    } catch (e) {
      // The runs changed since they were read: required steps are open. The dialog stays
      // open, lists them and asks why (nothing was changed on the case).
      const refused = stepsOpenRefusal(e);
      if (refused !== null) {
        const message = 'Required runbook steps are open. Say why you are closing the case.';
        // A refusal that names no step falls back to the loaded runs; with none loaded
        // either, the field is not on screen, so the sentence goes to a toast.
        setRefusedSteps(refused.length ? refused : null);
        setOpenStepsError(message);
        if (!refused.length && !openRequiredSteps(runbooks.data).length) toast.error(message);
        void runbooks.refresh();
        return;
      }
      // A failed lifecycle action is a MUTATION failure, not a case-load failure: use a
      // toast (like postMessage/notify) so we never mislabel it as "Could not load case".
      toast.error(e instanceof Error ? e.message : 'The action could not be completed.');
      setPending(null);
    } finally {
      setActing(false);
    }
  }, [
    pending,
    note,
    priority,
    actionAssignee,
    actionsTaken,
    actionDisposition,
    dispositionDeclared,
    actionReason,
    openStepsReason,
    refusedSteps,
    runbooks,
    id,
    c,
    grading,
    currentUser,
    resetActionFields,
    loadTriage,
    loadActivity,
    activity,
    commitCase,
    onAdvance,
    hasPermission,
    onCaseChange,
  ]);

  // The case a reinvestigation returned (the blocking dialog; WP09 reports through the
  // investigation store instead). Only the case it was asked for is shown.
  const onReinvestigated = React.useCallback(
    (next: Case) => {
      if (activeIdRef.current !== next.case_id) {
        onCaseChange?.(next);
        return;
      }
      commitCase(next);
      setRationale(null);
      // A trace on screen stays there and is read again quietly, so the end of a run the
      // analyst watched never blanks it to a skeleton; one not loaded loads lazily.
      if (timelineShownRef.current) void refreshTimelineQuietly();
      else setTimeline(null);
      setStages(null);
      void loadTriage();
    },
    [commitCase, loadTriage, onCaseChange, refreshTimelineQuietly],
  );

  const runExport = React.useCallback(
    async (fmt: 'json' | 'md') => {
      setExporting(fmt);
      try {
        const res = await api.exportCase(id, fmt);
        // The shared download helper attaches the anchor for the click and revokes the
        // object URL LATE (Safari/Firefox cancel a download revoked synchronously).
        const started = downloadText(
          res.filename || `case-${id}.${fmt === 'md' ? 'md' : 'json'}`,
          res.content_type || (fmt === 'md' ? 'text/markdown' : 'application/json'),
          res.content,
        );
        if (started) toast.success(fmt === 'md' ? 'Markdown report downloaded.' : 'Case JSON downloaded.');
        else toast.error('Downloads are not available in this browser.');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'The export could not be generated.');
      } finally {
        setExporting(null);
      }
    },
    [id],
  );

  // Open this case in a standalone browser tab. Both the legacy Cases sheet and the
  // embedded Case Manager understand the generic `caseId` hash query, so preserve the
  // current presentation's home instead of unexpectedly bouncing an inline analyst
  // back to the legacy table. Read-only: opening a tab never touches the decision (#3).
  const openInNewTab = React.useCallback(() => {
    if (typeof window === 'undefined' || !id) return;
    const base = window.location.href.split('#')[0];
    const routeId = presentation === 'embedded' ? 'case_manager' : 'cases';
    const url = `${base}#/${routeId}?caseId=${encodeURIComponent(id)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [id, presentation]);

  const shareCase = React.useCallback(async () => {
    if (typeof window === 'undefined' || !id) return;
    const base = window.location.href.split('#')[0];
    const routeId = presentation === 'embedded' ? 'case_manager' : 'cases';
    const ok = await copyText(`${base}#/${routeId}?caseId=${encodeURIComponent(id)}`);
    if (ok) toast.success('Case link copied.');
    else toast.error('Could not copy the case link.');
  }, [id, presentation]);

  // ---- keyboard shortcuts (CM-4/CM-3; Round 16 [cmux] §5.10) --------------- //
  // A / C / E / H acknowledge, close, escalate or hold (each OPENS its dialog: every
  // mutation still goes through its dialog), R reinvestigate (always confirmed), M the
  // owner picker, T the tags editor, ] the inspector, W the trace while the AI works,
  // Alt+1 to Alt+6 switch tabs. Active only while focus is NOT in text entry and no menu,
  // popover or dialog of this case is open.
  const shortcutStateRef = React.useRef({
    blocked: false,
    actions: [] as ActionDef[],
    canAssign: false,
    canTag: false,
    canReinvestigate: false,
    aiRunning: false,
  });
  // The D8.2 table: the lifecycle plan for the status, with the auto-close review's rows
  // (Start review on a pending sample, "Review this auto-close" in place of Set disposition
  // on any other case the agent closed).
  const lifecyclePlan = actionPlanForStatus(c?.status);
  const layout = reviewActionLayout(lifecyclePlan, {
    agentClosed,
    review: reviewState,
    canReview: canWriteCase,
  });
  const permittedForShortcuts = [layout.primary, ...layout.overflow].filter(
    (action, index, actions): action is ActionDef =>
      Boolean(action) &&
      actions.findIndex((candidate) => candidate?.key === action?.key) === index &&
      hasPermission(ACTION_PERMISSION[action!.key].resource, ACTION_PERMISSION[action!.key].action),
  );
  // A pending sample's review card is warmed before Start review is pressed.
  React.useEffect(() => {
    if (layout.startReview) void loadReviewCard().catch(() => undefined);
  }, [layout.startReview]);
  const shownIsCurrent = Boolean(c && c.case_id === id);
  shortcutStateRef.current = {
    blocked:
      !shownIsCurrent ||
      loading ||
      acting ||
      pending !== null ||
      takeActionOpen ||
      reinvestOpen ||
      notifyOpen ||
      ownerOpen ||
      tagsEditor !== null ||
      detailsOpen,
    actions: permittedForShortcuts,
    canAssign: hasPermission('cases', 'assign'),
    canTag: hasPermission('cases', 'write'),
    canReinvestigate,
    aiRunning,
  };
  const openActionRef = React.useRef(openAction);
  openActionRef.current = openAction;
  const openTagsEditorRef = React.useRef(openTagsEditor);
  openTagsEditorRef.current = openTagsEditor;
  // `]` and the header's toggle: the column when the pane has room for it, else the sheet.
  const toggleInspector = React.useCallback(() => {
    const probe = probeRef.current;
    if (probe && elementShown(probe)) {
      setInspectorOpen(!inspectorOpenRef.current);
      return;
    }
    setDetailsOpen(true);
  }, [setInspectorOpen]);
  const toggleInspectorRef = React.useRef(toggleInspector);
  toggleInspectorRef.current = toggleInspector;
  // W: the live trace, while an AI run is under way.
  const watchAiRun = React.useCallback(() => {
    setTab('investigation');
    traceTickRef.current += 1;
    setTraceRequest({ tick: traceTickRef.current, caseId: id });
  }, [id]);
  const watchAiRunRef = React.useRef(watchAiRun);
  watchAiRunRef.current = watchAiRun;

  // Whether the inspector column fits the pane (the probe's container query), kept in
  // step with the pane's width so the toggle's pressed state is true to what it does.
  React.useLayoutEffect(() => {
    const root = tabsRootRef.current;
    const probe = probeRef.current;
    if (!root || !probe) return undefined;
    const measure = () => setColumnFits(elementShown(probe));
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
  }, [open, caseShown]);

  React.useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      // Text entry, a Select (typeahead), a menu or a radio group consumes letters itself;
      // an open picker owns the keyboard. One key must never do two things.
      if (shortcutBlocked(event)) return;
      // A key typed inside another dialog (a rule sheet, a runbook's reason dialog, the
      // Start runbook picker) belongs to that dialog, never to the case behind it. The
      // case's own sheet is a dialog too, so only a dialog that is not this case counts.
      const target = event.target instanceof Element ? event.target : null;
      const dialog = target?.closest('[role="dialog"]');
      if (dialog && !dialog.contains(titleRef.current)) return;
      // A different modal surface (a palette, another dialog) owns the keyboard.
      if (presentation === 'embedded' && document.querySelector('[role="dialog"][data-state="open"]')) return;
      const state = shortcutStateRef.current;
      if (state.blocked) return;
      if (event.altKey) {
        const digit = /^Digit([1-6])$/.exec(event.code);
        if (!digit) return;
        // Every tab is shown to every viewer, so Alt+N always means the same tab.
        event.preventDefault();
        setTab(CASE_TABS[Number(digit[1]) - 1]);
        return;
      }
      if (event.key === ']') {
        event.preventDefault();
        toggleInspectorRef.current();
        return;
      }
      if (event.shiftKey) return;
      const key = event.key.toLowerCase();
      const byKind = (kind: ActionKind) => state.actions.find((a) => a.key === kind);
      const fire = (action: ActionDef | undefined) => {
        if (!action) return;
        event.preventDefault();
        actionOpenerRef.current =
          document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : takeActionTriggerRef.current;
        openActionRef.current(action);
      };
      if (key === 'a') fire(byKind('acknowledge'));
      else if (key === 'c') fire(byKind('close_disposition'));
      else if (key === 'e') fire(byKind('escalate'));
      else if (key === 'h') fire(byKind('hold'));
      else if (key === 'r' && state.canReinvestigate && !state.aiRunning) {
        event.preventDefault();
        actionOpenerRef.current = takeActionTriggerRef.current;
        setReinvestOpen(true);
      } else if (key === 'w' && state.aiRunning) {
        event.preventDefault();
        watchAiRunRef.current();
      } else if (key === 'm' && state.canAssign) {
        event.preventDefault();
        setOwnerOpen(true);
      } else if (key === 't' && state.canTag) {
        event.preventDefault();
        openTagsEditorRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, presentation]);

  // The header's scroll-edge fade: shown only while the tab content has scrolled under it.
  const onPanelScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const header = headerRef.current;
    if (!header) return;
    if (event.currentTarget.scrollTop > 0) header.dataset.scrolled = 'true';
    else delete header.dataset.scrolled;
  }, []);

  if (!open) return null;

  // Take action holds every OTHER verb (D8.2): the primary contextual action is the
  // header button, so the menu never repeats it. With Start review as the primary, every
  // lifecycle verb (Reopen first) is in the menu.
  const lifecyclePrimary = layout.primary;
  const permittedLifecycleActions = permittedForShortcuts.filter(
    (action) => !lifecyclePrimary || action.key !== lifecyclePrimary.key,
  );
  const outcome = c ? caseOutcome(c) : null;
  const busy = loading || acting || !shownIsCurrent;
  const canPrimary = lifecyclePrimary
    ? hasPermission(ACTION_PERMISSION[lifecyclePrimary.key].resource, ACTION_PERMISSION[lifecyclePrimary.key].action)
    : false;
  // The close-with-disposition action this status offers (the primary, or in Take action).
  const planClose = planCloseAction(lifecyclePlan);
  const canClose = planClose
    ? hasPermission(ACTION_PERMISSION[planClose.key].resource, ACTION_PERMISSION[planClose.key].action)
    : false;
  const setDispositionAction = permittedLifecycleActions.find((a) => a.key === 'set_disposition');
  const shortcutFor = (key: ActionKind): string | null =>
    key === 'acknowledge'
      ? 'A'
      : key === 'close_disposition'
        ? 'C'
        : key === 'escalate'
          ? 'E'
          : key === 'hold'
            ? 'H'
            : null;
  const openFromControl = (action: ActionDef, control: HTMLElement | null) => {
    actionOpenerRef.current = control;
    openAction(action);
  };
  // The AI's own steps (agent and tool), the same number as the trace's "N AI steps".
  const traceAiSteps = timeline?.spans ? traceStepCounts(timeline.spans).ai : null;
  const messageCount = thread ? visibleMessageCount(thread) : null;
  const runbookData = runbooks.data;
  const runbookProgress = caseProgress(runbookData);
  const shownRun = primaryRun(runbookData);
  // The auto-close entry for the case's verdict (B27): from the policy `decide()` acts on
  // when the settings were read, else from the triage read (C60).
  const verdictPolicy: FpPolicy = (autoClosePolicy ? policyForVerdict(autoClosePolicy, c?.verdict) : null) ?? triagePolicy;
  // The close dialog's open required steps (a terminal action on a case not yet ended).
  const pendingTerminal =
    pending !== null && isTerminalVerb(pending.wireAction ?? pending.key) && !caseIsTerminal(c?.status);
  const dialogOpenSteps: OpenRequiredStep[] = !pendingTerminal
    ? []
    : refusedSteps
      ? openStepsFromRefusal(refusedSteps, runbookData)
      : openRequiredSteps(runbookData);
  const canTag = canWriteCase && shownIsCurrent;
  // The inspector is a column when the pane has room and the viewer keeps it shown.
  const columnShown = columnFits && inspectorOpen;
  const nameOf = (u: string) => pickUsers.find((p) => p.username === u)?.display_name || u;
  // The inspector renders in the column beside the tabs and, in a narrow pane, in the
  // sheet; the tag editor opens only in the one being looked at.
  const renderRail = (placement: 'column' | 'sheet') =>
    c && outcome ? (
      <FactsRail
        c={c}
        outcome={outcome}
        triage={triage}
        slaPolicy={slaPolicy}
        serverSla={serverSla}
        assetRange={assetRange}
        policy={verdictPolicy}
        canViewCost={canViewCost}
        onCaseChange={commitCase}
        onSetDisposition={
          setDispositionAction ? () => openFromControl(setDispositionAction, takeActionTriggerRef.current) : undefined
        }
        onShowRelated={() => {
          if (placement === 'sheet') {
            sheetLeavesFocusRef.current = true;
            setDetailsOpen(false);
          }
          openTabSection('evidence', 'related-cases');
        }}
        onShowEvents={() => {
          if (placement === 'sheet') {
            sheetLeavesFocusRef.current = true;
            setDetailsOpen(false);
          }
          // Every event of the case, never a finding's narrowed set.
          setEventFilter(null);
          openTabSection('evidence', 'what-happened');
        }}
        canTag={canTag}
        tagsOpen={tagsEditor === placement}
        onTagsOpenChange={(next) => setTagsEditor(next ? placement : null)}
        campaign={campaign}
        onOpenCampaign={onNavigate ? () => onNavigate('campaigns') : undefined}
        review={agentClosed ? { state: reviewState, bandShown: layout.startReview } : undefined}
      />
    ) : null;
  // The auto-close review sheet (Round 15, D6.6, D6.9): opened from Start review, the
  // review chip or Take action; a recorded review re-reads the case and the state.
  const openReview = (opener: HTMLElement | null) => {
    reviewOpenerRef.current = opener;
    setTakeActionOpen(false);
    setDetailsOpen(false);
    setReviewSession((n) => n + 1);
    setReviewOpen(true);
  };
  const onReviewRecorded = () => {
    setReviewTick((n) => n + 1);
    void loadCase();
    if (activity !== null) void loadActivity();
    onReviewChange?.();
  };
  const onReviewReopened = (updated: Case | null) => {
    if (updated && activeIdRef.current === updated.case_id) commitCase(updated);
    setReviewTick((n) => n + 1);
    void loadTriage();
    if (activity !== null) void loadActivity();
    onReviewChange?.();
  };
  const restoreTo = (ref: React.RefObject<HTMLElement | null>) => (event: Event) => {
    const target = [ref.current, takeActionTriggerRef.current].find(
      (el): el is HTMLElement => Boolean(el && el.isConnected),
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };
  // A finding's "Cites N events": Evidence, narrowed to the events it cites.
  const showFindingEvents = (eventIds: string[]) => {
    setEventFilter(eventIds.length ? eventIds : null);
    openTabSection('evidence', 'what-happened');
  };

  return (
    <TooltipProvider delayDuration={200}>
      <CaseDetailSurface
        presentation={presentation}
        open={open}
        onClose={onClose}
        titleRef={titleRef}
      >
        <MotionProvider>
          <Tabs
            ref={tabsRootRef}
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            className="@container/case flex h-full min-h-0 flex-col"
            data-case-busy={busy ? 'true' : undefined}
          >
            {/* --------------------------------------- sticky header (118px, Round 16) */}
            <div
              ref={headerRef}
              data-testid="case-detail-header"
              className={cn(
                materialBar,
                'relative z-10 shrink-0 px-4 pt-2 @[48rem]/case:px-5 @[64rem]/case:px-6',
                presentation === 'sheet' && 'pr-14 @[48rem]/case:pr-14 @[64rem]/case:pr-14',
              )}
            >
              <LoadingBar
                active={loading && Boolean(c)}
                size="sm"
                label="Loading case"
                className="absolute inset-x-0 top-0 rounded-none"
              />
              {/* Row 1 (44px): the title keeps every pixel the actions leave and never
                  wraps (its full text on hover and in its accessible name). Below a 40rem
                  pane the primary action is an icon with a tooltip and Ask AI folds into
                  Take action ("Ask about this case"). */}
              <header className="flex h-11 min-w-0 flex-nowrap items-center gap-2 @[40rem]/case:gap-3" data-testid="case-title-row">
                {presentation === 'embedded' ? (
                  /* Below the split (one screen at a time) Back is the first item. The
                     marker tells Case Manager the header has its own Back, so its separate
                     back bar steps aside and a phone keeps one back control. */
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 xl:hidden"
                    aria-label="Back to case queue"
                    data-testid="case-back"
                    data-case-header-back=""
                    onClick={onClose}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden />
                  </Button>
                ) : null}
                <div className="min-w-0 flex-1" data-testid="case-title-cell">
                  {/* UNTRUSTED title: a plain text node. The SAME heading element is rendered
                      while the case loads (visually hidden, "Loading case"), so the sheet can
                      focus it on open and keep that focus when the case arrives, never an icon
                      button whose tooltip would then open by itself (CM-9). */}
                  <h2
                    ref={titleRef}
                    tabIndex={-1}
                    title={c ? c.title || c.case_id : undefined}
                    data-case-title
                    className={cn(
                      'truncate text-lg font-semibold leading-8 text-foreground outline-none @[56rem]/case:text-xl',
                      !c && 'sr-only',
                      c && !shownIsCurrent && 'opacity-60',
                    )}
                  >
                    {c ? c.title || c.case_id : 'Loading case'}
                  </h2>
                  {!c ? <Skeleton className="h-4 w-72 max-w-full" /> : null}
                </div>

                <div className="flex shrink-0 items-center gap-1.5 @[40rem]/case:gap-2">
                  {/* ONE primary contextual action (the D8.2 table: `actionPlanForStatus`,
                      with Start review on a pending auto-close sample). */}
                  {c && layout.startReview ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          className="h-8 px-2 @[40rem]/case:px-3"
                          data-testid="case-primary-action"
                          aria-label={START_REVIEW_LABEL}
                          disabled={busy}
                          onClick={(event) => openReview(event.currentTarget)}
                        >
                          <ClipboardCheck className="h-4 w-4" aria-hidden />
                          <span className="hidden @[40rem]/case:inline">{START_REVIEW_LABEL}</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{START_REVIEW_HELP}</TooltipContent>
                    </Tooltip>
                  ) : c && lifecyclePrimary && canPrimary ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          className="h-8 px-2 @[40rem]/case:px-3"
                          data-testid="case-primary-action"
                          aria-label={lifecyclePrimary.label}
                          disabled={busy}
                          aria-keyshortcuts={shortcutFor(lifecyclePrimary.key) ?? undefined}
                          onClick={(event) => openFromControl(lifecyclePrimary, event.currentTarget)}
                        >
                          {React.createElement(lifecyclePrimary.icon, { className: 'h-4 w-4' })}
                          <span className="hidden @[40rem]/case:inline">{lifecyclePrimary.label}</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{lifecyclePrimary.help}</TooltipContent>
                    </Tooltip>
                  ) : null}

                  {/* Take action: every other verb, the investigation tools, export and notify. */}
                  <DropdownMenu open={takeActionOpen} onOpenChange={setTakeActionOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        ref={takeActionTriggerRef}
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 px-0 @[40rem]/case:w-auto @[40rem]/case:px-3"
                        disabled={!c}
                        aria-label="Take action"
                      >
                        {/* Below a 40rem pane (a phone) the menu is an icon, so the title keeps
                            the row; its name stays "Take action". */}
                        <ListChecks className="h-4 w-4 @[40rem]/case:hidden" aria-hidden />
                        <span className="hidden @[40rem]/case:inline">Take action</span>
                        <ChevronDown className="hidden h-3.5 w-3.5 @[40rem]/case:inline" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      sideOffset={8}
                      className="w-72"
                      // B28: an editor chosen here opens once the menu has closed, and the
                      // menu does not take focus back first (that focus move dismissed the
                      // non-modal editor). The editor takes focus and returns it to its own
                      // trigger when it closes.
                      onCloseAutoFocus={(event) => {
                        const editor = pendingMenuEditorRef.current;
                        if (!editor) return;
                        pendingMenuEditorRef.current = null;
                        event.preventDefault();
                        if (editor === 'owner') setOwnerOpen(true);
                        else openTagsEditor();
                      }}
                    >
                      {/* The group's label and separator go with its items: a role that may
                          change nothing about the case (an auditor) gets no empty group. */}
                      {permittedLifecycleActions.length > 0 || layout.reviewInMenu ? (
                        <>
                          <DropdownMenuLabel>Case actions</DropdownMenuLabel>
                          {/* D4.7, D8.2: on a case the agent closed, the review takes Set
                              disposition's place. */}
                          {layout.reviewInMenu ? (
                            <DropdownMenuItem
                              disabled={busy}
                              onSelect={() => openReview(takeActionTriggerRef.current)}
                            >
                              <ClipboardCheck className="h-4 w-4" />
                              <span className="flex-1">{REVIEW_MENU_LABEL}</span>
                            </DropdownMenuItem>
                          ) : null}
                          {permittedLifecycleActions.map((action) => {
                            const Icon = action.icon;
                            const hint = shortcutFor(action.key);
                            return (
                              <DropdownMenuItem
                                key={action.key}
                                disabled={busy}
                                aria-keyshortcuts={hint ?? undefined}
                                onSelect={() => openFromControl(action, takeActionTriggerRef.current)}
                              >
                                <Icon className="h-4 w-4" />
                                <span className="flex-1">{action.label}</span>
                                {hint ? <MenuShortcut>{hint}</MenuShortcut> : null}
                              </DropdownMenuItem>
                            );
                          })}
                          <DropdownMenuSeparator />
                        </>
                      ) : null}
                      <DropdownMenuLabel>Investigation</DropdownMenuLabel>
                      {canReinvestigate ? (
                        // While a run is queued or running a second one is refused, so the
                        // item stays FOCUSABLE (`aria-disabled`, never Radix `disabled`,
                        // which roving focus skips) and says why in the reading order.
                        <DropdownMenuItem
                          disabled={busy}
                          aria-disabled={aiRunning || undefined}
                          aria-keyshortcuts={aiRunning ? undefined : 'R'}
                          className={cn(aiRunning && 'text-muted-foreground')}
                          data-testid="case-action-reinvestigate"
                          onSelect={(event) => {
                            if (aiRunning) {
                              event.preventDefault();
                              return;
                            }
                            actionOpenerRef.current = takeActionTriggerRef.current;
                            setTakeActionOpen(false);
                            setReinvestOpen(true);
                          }}
                        >
                          <Zap className="h-4 w-4" />
                          <span className="min-w-0 flex-1">
                            Reinvestigate
                            {aiRunning ? (
                              <span className="block text-2xs text-muted-foreground">{REINVESTIGATE_RUNNING_HINT}</span>
                            ) : null}
                          </span>
                          {aiRunning ? null : <MenuShortcut>R</MenuShortcut>}
                        </DropdownMenuItem>
                      ) : null}
                      {canReadRunbooks && canRunRunbooks && runbookPrefs.enabled ? (
                        <DropdownMenuItem
                          disabled={busy}
                          onSelect={() => {
                            setTakeActionOpen(false);
                            requestRunbook({ kind: 'start' });
                          }}
                        >
                          <BookCheck className="h-4 w-4" />
                          Start runbook
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        disabled={loading}
                        onSelect={() => {
                          setTakeActionOpen(false);
                          void loadCase();
                        }}
                      >
                        <RefreshCw className="h-4 w-4" />
                        Refresh case
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-keyshortcuts="Alt+6"
                        onSelect={() => {
                          setTakeActionOpen(false);
                          setTab('chat');
                        }}
                      >
                        <MessageSquare className="h-4 w-4" />
                        <span className="flex-1">Ask about this case</span>
                        <MenuShortcut>Alt 6</MenuShortcut>
                      </DropdownMenuItem>
                      {hasPermission('cases', 'assign') ? (
                        <DropdownMenuItem
                          disabled={busy}
                          aria-keyshortcuts="M"
                          onSelect={() => {
                            // B28: opened by the menu's onCloseAutoFocus, once it has closed.
                            pendingMenuEditorRef.current = 'owner';
                            setTakeActionOpen(false);
                          }}
                        >
                          <UserCheck className="h-4 w-4" />
                          <span className="flex-1">Change owner</span>
                          <MenuShortcut>M</MenuShortcut>
                        </DropdownMenuItem>
                      ) : null}
                      {canWriteCase ? (
                        <DropdownMenuItem
                          disabled={busy}
                          aria-keyshortcuts="T"
                          onSelect={() => {
                            // B28: opened by the menu's onCloseAutoFocus, once it has closed.
                            pendingMenuEditorRef.current = 'tags';
                            setTakeActionOpen(false);
                          }}
                        >
                          <TagIcon className="h-4 w-4" />
                          <span className="flex-1">Edit tags</span>
                          <MenuShortcut>T</MenuShortcut>
                        </DropdownMenuItem>
                      ) : null}

                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Export and notify</DropdownMenuLabel>
                      <DropdownMenuItem
                        disabled={exporting !== null || !c}
                        onSelect={() => {
                          setTakeActionOpen(false);
                          void runExport('json');
                        }}
                      >
                        <Download className="h-4 w-4" />
                        Export JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={exporting !== null || !c}
                        onSelect={() => {
                          setTakeActionOpen(false);
                          void runExport('md');
                        }}
                      >
                        <FileText className="h-4 w-4" />
                        Export Markdown report
                      </DropdownMenuItem>
                      {canWriteCase ? (
                        <DropdownMenuItem
                          disabled={busy}
                          onSelect={() => {
                            actionOpenerRef.current = takeActionTriggerRef.current;
                            setTakeActionOpen(false);
                            setNotifyChannelId('');
                            setNotifyOpen(true);
                          }}
                        >
                          <Send className="h-4 w-4" />
                          Notify
                        </DropdownMenuItem>
                      ) : null}
                      {campaign && onNavigate ? (
                        <DropdownMenuItem
                          onSelect={() => {
                            setTakeActionOpen(false);
                            onNavigate('campaigns');
                          }}
                        >
                          <Shield className="h-4 w-4" />
                          Open campaign
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Ask AI: the case chat (the Chat tab, Alt+6), one engine (#5). */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="hidden h-8 px-2 @[40rem]/case:inline-flex"
                        disabled={!c}
                        aria-label="Ask AI about this case"
                        aria-keyshortcuts="Alt+6"
                        data-testid="case-ask-ai"
                        onClick={() => setTab('chat')}
                      >
                        <Bot className="h-4 w-4" aria-hidden />
                        <span className="hidden @[56rem]/case:inline">Ask AI</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Ask AI about this case</TooltipContent>
                  </Tooltip>

                  {/* More options: the case's link (copy it, or open it in a new tab). */}
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="More options" disabled={!c}>
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">More options</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" sideOffset={8} className="w-56">
                      <DropdownMenuItem onSelect={() => void shareCase()}>
                        <Link2 className="h-4 w-4" />
                        Copy link
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => openInNewTab()}>
                        <ExternalLink className="h-4 w-4" />
                        Open in new tab
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* The inspector: a column when the pane has room (pressed while shown),
                      otherwise the same facts in a non-blocking side sheet. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        ref={detailsTriggerRef}
                        variant="ghost"
                        size="icon"
                        className={cn('h-8 w-8', columnShown && 'bg-accent/70 text-foreground')}
                        disabled={!c}
                        aria-label="Case facts"
                        aria-pressed={columnFits ? inspectorOpen : undefined}
                        aria-keyshortcuts="]"
                        data-testid="case-inspector-toggle"
                        onClick={toggleInspector}
                      >
                        <PanelRight className="h-4 w-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {columnFits ? (inspectorOpen ? 'Hide case facts' : 'Show case facts') : 'Case facts'}
                    </TooltipContent>
                  </Tooltip>

                  {presentation === 'embedded' ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hidden h-8 w-8 xl:inline-flex"
                      aria-label="Back to case queue"
                      onClick={onClose}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </header>
              {/* Row 2 (24px): the meta strip, one line at every width. */}
              {c && outcome ? (
                <CaseHeaderMeta
                  c={c}
                  outcome={outcome}
                  users={pickUsers}
                  currentUser={currentUser}
                  canAssign={hasPermission('cases', 'assign') && shownIsCurrent}
                  slaPolicy={slaPolicy}
                  serverSla={serverSla}
                  triage={triage}
                  assetRange={assetRange}
                  onCaseChange={commitCase}
                  ownerOpen={ownerOpen}
                  onOwnerOpenChange={setOwnerOpen}
                  onStartReview={layout.startReview ? (opener) => openReview(opener) : undefined}
                />
              ) : (
                <div className="flex h-6 items-center">
                  <Skeleton className="h-3 w-96 max-w-full" />
                </div>
              )}

              {/* The tabs (36px), one lane each (D8), on Alt+1 to Alt+6. */}
              <TabsList variant="underline" density="compact" className="mt-1.5" aria-label="Case sections">
                <TabsTrigger value="overview" aria-keyshortcuts="Alt+1" disabled={!c}>
                  Brief
                </TabsTrigger>
                <TabsTrigger value="evidence" aria-keyshortcuts="Alt+2" disabled={!c}>
                  Evidence
                </TabsTrigger>
                <TabsTrigger value="investigation" className="gap-1.5" aria-keyshortcuts="Alt+3" disabled={!c}>
                  AI investigation
                  {traceAiSteps ? (
                    <TabCount label={traceAiSteps === 1 ? 'AI step' : 'AI steps'}>{traceAiSteps}</TabCount>
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="runbook" className="gap-1.5" aria-keyshortcuts="Alt+4" data-tab="runbook" disabled={!c}>
                  Response
                  {/* The runbook's progress when one is attached. No "None": the tab also
                      holds the case's tasks, so it is never empty. */}
                  {runbookData && canReadRunbooks && (runbookProgress || runbookData.runs.length > 0) ? (
                    <RunbookTabCount progress={runbookProgress} abandoned={runbookData.runs.length > 0} />
                  ) : null}
                </TabsTrigger>
                <TabsTrigger value="collab" className="gap-1.5" aria-keyshortcuts="Alt+5" disabled={!c}>
                  Activity
                  {messageCount ? <TabCount label="messages">{messageCount}</TabCount> : null}
                </TabsTrigger>
                <TabsTrigger value="chat" aria-keyshortcuts="Alt+6" disabled={!c}>
                  Chat
                  {/* A case chat answer being written, unread, waiting or failed (SPEC D13). */}
                  {c ? <CaseChatActivityGlyph caseId={c.case_id} className="ml-1.5" /> : null}
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ----------------------------------------------------- body */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {error ? (
                  <div className="px-6 pt-4">
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Could not load case</AlertTitle>
                      <AlertDescription>
                        {error instanceof Error ? error.message : 'Something went wrong.'}
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : null}

                {!c ? (
                  loading ? (
                    <LoadingState
                      label="Loading case"
                      description="Retrieving the case record and its evidence."
                      layout="page"
                      shape="page"
                      className="px-6"
                    />
                  ) : null
                ) : (
                  <div
                    ref={panelScrollRef}
                    onScroll={onPanelScroll}
                    data-testid="case-detail-scroll"
                    className={cn(
                      'min-h-0 flex-1 transition-opacity duration-fast',
                      tab === 'chat' ? 'overflow-hidden' : 'overflow-y-auto',
                      !shownIsCurrent && 'opacity-60',
                    )}
                    aria-busy={loading || undefined}
                  >
                    <TabsContent value="overview" className="mt-0">
                      <TabPanelMotion>
                        <OverviewPanel
                          c={c}
                          rationale={rationale}
                          onNavigate={onNavigate}
                          onOpenTab={setTab}
                          reviewPending={layout.startReview}
                          runbookRun={canReadRunbooks ? shownRun : null}
                          onOpenRunbook={(stepId) => requestRunbook(stepId ? { kind: 'step', stepId } : { kind: 'card' })}
                          runbookProgress={canReadRunbooks ? runbookProgress : null}
                          messageCount={messageCount}
                          filesCount={filesCount ? filesCount.count : null}
                          timeline={timeline}
                          policy={verdictPolicy}
                          canOpenApprovals={canReadProposals}
                          onNeedTimeline={() => setTimelineWanted(true)}
                          buildStoryOpen={storyOpen}
                          onBuildStoryOpenChange={setStoryOpen}
                          buildStory={
                            /* The six-stage story, folded: every stage, the one place the
                               lanes meet. Its stages load when it opens. */
                            <TimelinePanel
                              stages={stages}
                              stagesLoading={stagesLoading}
                              stagesError={stagesError}
                              onRetryStages={loadStages}
                              onOpenInvestigation={() => setTab('investigation')}
                            />
                          }
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="evidence" className="mt-0">
                      <TabPanelMotion>
                        {/* The source lane: what happened (fenced), the events, entities, threat
                            context, related cases and the baseline (Round 16, D8). */}
                        <EvidencePanel
                          c={c}
                          onNavigate={onNavigate}
                          filterEventIds={eventFilter}
                          onClearEventFilter={() => setEventFilter(null)}
                          sourceStory={
                            <TimelinePanel
                              stages={stages}
                              stagesLoading={stagesLoading}
                              stagesError={stagesError}
                              onRetryStages={loadStages}
                              kinds={SOURCE_STAGES}
                            />
                          }
                          threatContext={
                            <ThreatContextPanel
                              c={c}
                              panel={threat}
                              loading={threatLoading}
                              error={threatError}
                              onRetry={loadThreat}
                              onNavigate={onNavigate}
                            />
                          }
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="investigation" className="mt-0">
                      <TabPanelMotion>
                        {/* The AI lane: the assessment, the inputs, the trace and earlier
                            gradings (Round 16, D8). */}
                        <InvestigationPanel
                          c={c}
                          rationale={rationale}
                          rationaleLoading={rationaleLoading}
                          rationaleError={rationaleError}
                          onRetryRationale={loadRationale}
                          timeline={timeline}
                          timelineLoading={timelineLoading}
                          timelineError={timelineError}
                          onRetryTimeline={loadTimeline}
                          traceRequest={shownIsCurrent && traceRequest?.caseId === id ? traceRequest.tick : null}
                          onTraceRequestHandled={traceRequestHandled}
                          aiRunning={aiRunning}
                          onShowEvents={showFindingEvents}
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="runbook" className="mt-0">
                      <TabPanelMotion>
                        {/* Response: the runbook for a viewer who may read runbooks (lazy), and
                            the case's tasks for everyone. */}
                        {canReadRunbooks ? (
                          <div className={CASE_MANAGER_PANEL_PADDING}>
                            <div data-testid="case-tab-first">
                              <React.Suspense
                                fallback={
                                  <LoadingState
                                    label="Loading the runbook"
                                    layout="panel"
                                    shape="rows"
                                    shapeRows={4}
                                  />
                                }
                              >
                                <RunbookPanel
                                  c={c}
                                  runbooks={runbooks}
                                  canRun={canRunRunbooks && shownIsCurrent}
                                  enabled={runbookPrefs.enabled}
                                  viewer={runbookViewer}
                                  canWriteTasks={canWriteCase && shownIsCurrent}
                                  hasPermission={hasPermission}
                                  currentUser={currentUser}
                                  users={pickUsers}
                                  aiDrafts={runbookPrefs.aiDrafts}
                                  aiSuggest={runbookPrefs.aiSuggest}
                                  focusRequest={runbookRequest}
                                  onFocusRequestHandled={runbookRequestHandled}
                                  onCloseCase={
                                    planClose && canClose
                                      ? () => openFromControl(planClose, document.activeElement as HTMLElement | null)
                                      : undefined
                                  }
                                />
                              </React.Suspense>
                            </div>
                          </div>
                        ) : (
                          <div className={CASE_MANAGER_PANEL_PADDING} data-case-panel="response">
                            <PanelSection title="Tasks" testId="response-tasks" tabFirst>
                              <OtherTasksLoader caseId={c.case_id} canWrite={canWriteCase} nameOf={nameOf} />
                            </PanelSection>
                          </div>
                        )}
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="collab" className="mt-0">
                      <TabPanelMotion>
                        <CollaborationThreadTab
                          c={c}
                          thread={thread}
                          threadLoading={threadLoading}
                          threadError={threadError}
                          threadBusyId={threadBusyId}
                          activity={activity}
                          activityLoading={activityLoading}
                          activityError={activityError}
                          users={pickUsers}
                          currentUser={currentUser}
                          canComment={canComment}
                          onRetryThread={loadThread}
                          onRetryActivity={loadActivity}
                          onPost={(text) => void postMessage(text)}
                          onReply={(parentId, text) => void postMessage(text, parentId)}
                          onEdit={(msgId, text) => void editMessage(msgId, text)}
                          onDelete={(msgId) => void removeMessage(msgId)}
                          onReact={(msgId, emoji, remove) => void reactMessage(msgId, emoji, remove)}
                          // The Files section (D5.12): the lazy screenshots gallery, with this
                          // tab as its paste scope and its count beside the heading.
                          renderFiles={(pasteScope) => (
                            <React.Suspense
                              fallback={
                                <LoadingState label="Loading screenshots" layout="panel" shape="rows" shapeRows={2} />
                              }
                            >
                              <CaseFiles
                                caseId={c.case_id}
                                refreshKey={filesTick}
                                pasteScopeRef={pasteScope}
                                heading="section"
                                onCountChange={(count, max) => setFilesCount({ count, max })}
                              />
                            </React.Suspense>
                          )}
                          filesAdornment={
                            filesCount ? (
                              <span className="text-xs tabular-nums text-muted-foreground">
                                {filesCount.max
                                  ? `${filesCount.count.toLocaleString()} of ${filesCount.max.toLocaleString()}`
                                  : filesCount.count.toLocaleString()}
                              </span>
                            ) : null
                          }
                          liveCaseId={id}
                          onLiveThread={liveRefreshThread}
                          onLiveActivity={liveRefreshActivity}
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="chat" className="mt-0 h-full min-h-0">
                      <TabPanelMotion className="h-full min-h-0">
                        <ChatTab c={c} />
                      </TabPanelMotion>
                    </TabsContent>
                  </div>
                )}
              </div>

              {/* The probe the inspector's container query shows from a 52rem pane: it tells
                  the toggle whether the column fits. Zero size, never announced. */}
              <span
                ref={probeRef}
                aria-hidden
                data-testid="case-inspector-probe"
                className="pointer-events-none hidden h-0 w-0 @[52rem]/case:block"
              />
              {/* The inspector: every tab, from a 52rem pane, while the viewer keeps it shown. */}
              {c && outcome && inspectorOpen ? (
                <div
                  ref={railColumnRef}
                  data-testid="case-facts-column"
                  className={cn(
                    'hidden w-[17rem] shrink-0 overflow-y-auto border-l border-border/70 px-4 py-4 @[52rem]/case:block @[72rem]/case:w-[19rem]',
                    !shownIsCurrent && 'opacity-60',
                  )}
                >
                  {renderRail('column')}
                </div>
              ) : null}
            </div>
          </Tabs>
        </MotionProvider>
      </CaseDetailSurface>

      {/* Narrow panes: the same facts in a NON-blocking side sheet (no scrim). */}
      <Sheet
        open={detailsOpen}
        onOpenChange={(next) => {
          setDetailsOpen(next);
          if (!next) {
            tagsInSheetRef.current = false;
            setTagsEditor((current) => (current === 'sheet' ? null : current));
          }
        }}
        modal={false}
      >
        <SheetContent
          side="right"
          size="default"
          className="overflow-y-auto p-5"
          aria-describedby={undefined}
          // Open on the sheet's heading, never its first help tip (whose explainer would
          // then pop open by itself); close back to the inspector toggle, not <body>: the
          // sheet is opened from state and non-modal, so Radix has no trigger to return to.
          // Opened by T or "Edit tags", it opens the tag editor instead, which takes focus.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (tagsInSheetRef.current) {
              tagsInSheetRef.current = false;
              setTagsEditor('sheet');
              return;
            }
            detailsTitleRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Closed by the related-cases link: the section's heading already has focus.
            if (sheetLeavesFocusRef.current) {
              sheetLeavesFocusRef.current = false;
              event.preventDefault();
              return;
            }
            const trigger = detailsTriggerRef.current;
            if (trigger && trigger.isConnected) {
              event.preventDefault();
              trigger.focus();
            }
          }}
        >
          <SheetTitle
            ref={detailsTitleRef}
            tabIndex={-1}
            className="mb-4 pr-10 text-base font-semibold leading-8 text-foreground outline-none"
          >
            Case facts
          </SheetTitle>
          {renderRail('sheet')}
        </SheetContent>
      </Sheet>

      {/* Reinvestigate: a detached dialog (not a nested popover), so its Select keeps its
          focus and keyboard behaviour after the menu closes; focus returns to the control
          that opened it. WP09 makes it non-blocking. */}
      <ReinvestigateDialog
        caseRecord={c && shownIsCurrent ? c : null}
        open={reinvestOpen}
        onOpenChange={setReinvestOpen}
        models={models}
        onReinvestigated={onReinvestigated}
        onCloseAutoFocus={restoreTo(actionOpenerRef)}
      />

      {/* --------------------------------------- confirm / close-with-disposition */}
      <ConfirmActionDialog
        caseIds={c && shownIsCurrent ? [c.case_id] : undefined}
        pending={pending}
        acting={acting}
        onClose={closeAction}
        onSubmit={() => void runAction(false)}
        onSubmitAndNext={onAdvance ? () => void runAction(true) : undefined}
        returnFocusTo={actionOpenerRef}
        focusAfterSubmit={resolveDialogFocus}
        note={note}
        onNoteChange={setNote}
        priority={priority}
        onPriorityChange={setPriority}
        assignee={actionAssignee}
        onAssigneeChange={setActionAssignee}
        actionsTaken={actionsTaken}
        onActionsTakenChange={setActionsTaken}
        disposition={actionDisposition}
        onDispositionChange={declareDisposition}
        currentDisposition={c?.disposition ?? null}
        reason={actionReason}
        onReasonChange={setActionReason}
        verdict={c?.verdict ?? null}
        confidence={c?.confidence ?? null}
        grading={grading}
        onGradingChange={setGrading}
        openSteps={dialogOpenSteps}
        openStepsReason={openStepsReason}
        onOpenStepsReasonChange={(value) => {
          setOpenStepsReason(value);
          if (openStepsError) setOpenStepsError(null);
        }}
        openStepsError={openStepsError}
        renderScreenshots={
          // D4.6: "Add screenshots" for a person who may add them (`cases:comment`, the
          // grant the upload route checks), with the dialog as the paste scope.
          canComment && c
            ? (pasteScope) => (
                <React.Suspense fallback={null}>
                  <CloseScreenshots caseId={c.case_id} pasteScopeRef={pasteScope} onUploaded={refreshFiles} />
                </React.Suspense>
              )
            : undefined
        }
      />

      {/* The auto-close review (D6.6, D6.9, D6.12): a non-blocking side sheet. */}
      <ReviewSheet
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        caseData={c && shownIsCurrent ? c : null}
        canReopen={hasPermission('cases', 'close')}
        session={reviewSession}
        returnFocusRef={reviewOpenerRef}
        onRecorded={onReviewRecorded}
        onReopened={onReviewReopened}
      />

      {/* Notify (manual send) dialog: F5/Wave 4. Picks one configured channel or
          all enabled; the send is fire-and-forget and never changes the case. */}
      <Dialog open={notifyOpen} onOpenChange={setNotifyOpen}>
        <DialogContent className="max-w-md" onCloseAutoFocus={restoreTo(actionOpenerRef)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Notify
            </DialogTitle>
            <DialogDescription>
              Send this case to a notification channel. Delivery is fire-and-forget and never
              changes the case.
            </DialogDescription>
          </DialogHeader>

          {!notifyEnabled ? (
            <Alert>
              <Send className="h-4 w-4" aria-hidden />
              <AlertTitle>Notifications are off</AlertTitle>
              <AlertDescription>
                Enable alerting under Settings → Alerting &amp; notifications and configure a
                channel first.
              </AlertDescription>
            </Alert>
          ) : notifyChannels.length === 0 ? (
            <Alert>
              <Send className="h-4 w-4" aria-hidden />
              <AlertTitle>No channels configured</AlertTitle>
              <AlertDescription>
                Add a channel under Settings → Alerting &amp; notifications.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-1.5 py-1">
              <Label>Channel</Label>
              <Select
                value={notifyChannelId || '__all__'}
                onValueChange={(v) => setNotifyChannelId(v === '__all__' ? '' : v)}
              >
                <SelectTrigger aria-label="Channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All enabled channels</SelectItem>
                  {notifyChannels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id} disabled={!ch.enabled}>
                      {ch.name} · {ch.type}
                      {ch.enabled ? '' : ' (disabled)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Choose a single channel, or send to every enabled channel at once.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setNotifyOpen(false)} disabled={notifying}>
              Cancel
            </Button>
            <Button
              onClick={() => void runNotify()}
              disabled={notifying || !notifyEnabled || notifyChannels.length === 0}
            >
              {notifying ? (
                <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};

/** How long frames during an AI run wait before the trace is read again (one read each). */
export const TRACE_REFRESH_MS = 1500;
/** The trace's poll for as long as an AI run is under way on the open trace. */
export const TRACE_POLL_MS = 5000;

/** A quiet count beside a tab label ("AI investigation 18"). */
const TabCount: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <span className="rounded-sm bg-muted px-1.5 text-2xs font-medium tabular-nums text-muted-foreground">
    <span className="sr-only">, </span>
    {children}
    <span className="sr-only"> {label}</span>
  </span>
);

/** A keyboard shortcut hint at the end of a menu item. */
const MenuShortcut: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd aria-hidden className="ml-auto font-sans text-xs text-muted-foreground">
    {children}
  </kbd>
);

export default CaseDetail;
