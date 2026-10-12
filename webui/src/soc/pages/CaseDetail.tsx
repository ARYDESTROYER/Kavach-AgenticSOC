/**
 * CaseDetail — the core analyst workflow surface (thin orchestrator).
 *
 * Opened with a `caseId`, it fetches the full case (`api.getCase`) and presents a
 * WIDE right-side Sheet modeled on the reference "case report" page:
 *   - a header (title, created/updated, action buttons: reinvestigate / run-playbook /
 *     refresh / chat / history / export / notify),
 *   - the tabbed body — one lazy panel per tab (Overview / Timeline / Investigation /
 *     Threat context / Collaboration / Chat). Task 5 split the merged investigation tab:
 *     the "Timeline" tab is now ONLY the "what happened" six-stage narrative
 *     (the TimelinePanel), and the new "Investigation" tab holds the AI assessment +
 *     the pinned deterministic DecisionCard + the collapsible full ReAct trace
 *     (the InvestigationPanel). The standalone Feedback tab was retired,
 *   - a footer with ONE context-dependent primary CTA, ONE unified Close-with-
 *     disposition secondary, and an overflow "More" menu,
 *   - the shared confirm-action dialog (every lifecycle action) + a Notify dialog.
 *
 * COUPLING-D SPLIT: the conceptual panels now live in `soc/pages/casedetail/*`
 * (OverviewPanel · InvestigationPanel · ThreatContextPanel · CollaborationPanel ·
 * CaseChatPanel), the lifecycle action model + small building blocks in `./shared`,
 * and the close-with-disposition dialog in `./ConfirmActionDialog`. This file is the
 * ORCHESTRATOR: it owns the fetch/lazy-load/mutation state and wires it to the panels.
 *
 * Contract: `CaseDetail({ caseId, onClose, onNavigate?, presentation? })` — `caseId`
 * null/empty renders nothing (closed). Cases / Scans / Investigate use the default
 * right-side sheet; Case Manager opts into the additive `embedded` presentation so the
 * SAME orchestrator, panels, RBAC gates, and deterministic lifecycle actions can live
 * inside its split workspace without forking business logic.
 *
 * SECURITY (#9): every case-derived value (title, summary, entity, IPs, rules,
 * queries, evidence, tool output, comments, tags, model keys, enrichment) is UNTRUSTED
 * — it is rendered as plain text or inside <CodeBlock>/<InlineCode>, never as markup.
 * #3: the unified Close-with-disposition still POSTs the EXISTING `close` verb (via
 * `wireAction`) so the backend runs the real decide()/apply() — this file never
 * invents a verb or makes a close/escalate decision itself.
 */
import * as React from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  MessageSquare,
  PanelRight,
  Play,
  RefreshCw,
  Send,
  Share2,
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
  Case,
  CaseActionInput,
  CaseRationale,
  ModelsResponse,
  Playbook,
  SlaPolicy,
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import { downloadText } from '@/lib/download';
import { errorMessage } from '@/lib/errorMessage';
import { fmtMoney, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Sheet, SheetContent, SheetTitle } from '@/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';
// motion.dev (lazy — CaseDetail is loaded off the lazy Cases chunk, never the eager
// first-paint graph): the tab-body cross-fade + the DecisionCard "verdict lands" one-shot.
// CaseDetail mounts its OWN MotionProvider so in-page motion works even on a deep link.
import { MotionProvider, TabPanelMotion } from '@/soc/components/motion';
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
  getTasks,
  addTask,
  patchTask,
  logTask,
  getActivity,
  listPickableUsers,
  type TriageChips,
  type TimelineResponse,
  type TimelineStagesResponse,
  type CaseMessage as ThreadMessage,
  type CaseTask as CaseTaskItem,
  type CaseActivityItem,
  type PickableUser,
  type TaskStatus,
} from '@/soc/pages/CaseDetail.api';

import type { Navigate } from '@/soc/router';

import { campaignsApi, type Campaign } from '@/soc/pages/Campaigns.api';

import {
  type ActionDef,
  type ActionKind,
  type FpPolicy,
  type NotifyChannelOption,
  ACTION_PERMISSION,
  actionPlanForStatus,
} from './casedetail/shared';
import { OverviewPanel } from './casedetail/OverviewPanel';
import { TimelinePanel } from './casedetail/TimelinePanel';
import { InvestigationPanel } from './casedetail/InvestigationPanel';
import { ThreatContextPanel } from './casedetail/ThreatContextPanel';
import { CollaborationThreadTab } from './casedetail/CollaborationPanel';
import { ChatTab } from './casedetail/CaseChatPanel';
import { ConfirmActionDialog } from './casedetail/ConfirmActionDialog';
import { CaseHeaderMeta } from './casedetail/CaseHeaderMeta';
import { FactsRail } from './casedetail/FactsRail';
import { shortcutBlocked } from './casedetail/keyboard';
import { keepAdvisoryBands } from './casedetail/queue';
import { CaseChatActivityGlyph, useCaseChatRequest } from '@/soc/chat-activity/case-glyph';
import {
  deriveAgreement,
  emptyGradingDraft,
  gradingToFeedbackInput,
  isGradingDirty,
  type GradingDraft,
} from './casedetail/grading';

// Re-export the co-located API types so existing importers keep working.
export type { ThreadMessage };

/**
 * Embedded (Case Manager) tab trigger: a calm, text-only underline tab. The active tab
 * reads in the foreground colour over a primary underline; the rest stay muted.
 */
const EMBEDDED_TAB_TRIGGER =
  'rounded-none border-b-2 border-transparent px-0 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground ' +
  'data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none';

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
   * `document.activeElement` is a pure read — nothing is mutated — so this is safe in
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
         * Focus RETURN on close (WCAG 2.4.3) — which Radix cannot do for this sheet.
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
         * default — the same pattern the Tuning inspector already uses.
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
}) => {
  const open = Boolean(caseId && caseId.trim());
  const id = caseId || '';

  // Staleness guard: the LATEST requested case id. Every id-keyed loader captures its
  // own `id` in a closure and applies its result ONLY if the case has not changed
  // mid-flight — the SAME CaseDetail instance is reused across cases (related-case
  // drill-through, reopening the sheet on a different row), so a slow response for
  // case A must never overwrite the freshly-opened case B.
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

  // Campaign membership (#51) — the cross-case campaign this case belongs to, if any.
  // Advisory only (#3/#4): a campaign is a reporting grouping that never closes /
  // escalates / re-clusters the case. Best-effort — campaigns may be disabled.
  const [campaign, setCampaign] = React.useState<Campaign | null>(null);
  const [tab, setTab] = React.useState<
    'overview' | 'timeline' | 'investigation' | 'threat' | 'collab' | 'chat'
  >('overview');
  // Round 12 (SPEC D13): "Open" on a case-chat toast lands on this case's Chat tab.
  useCaseChatRequest(open ? id : null, () => setTab('chat'));
  const panelScrollRef = React.useRef<HTMLDivElement>(null);

  // All six panels share one scroll lane. Reset it when the selected tab/case changes
  // so a deep Timeline scroll never opens Investigation halfway down the terminal.
  React.useEffect(() => {
    if (panelScrollRef.current) panelScrollRef.current.scrollTop = 0;
  }, [tab, id]);

  // Round 3 — triage chips (#12), eager so the overview header is honest on open.
  const [triage, setTriage] = React.useState<TriageChips | null>(null);
  const [triageLoading, setTriageLoading] = React.useState(false);

  // Round 3 — typed ReAct timeline (#12), lazy on the Timeline tab (powers the
  // DecisionCard's policy clause + the collapsible full trace).
  const [timeline, setTimeline] = React.useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = React.useState(false);
  const [timelineError, setTimelineError] = React.useState<unknown>(null);

  // Six-stage narrative, lazy on the Timeline tab.
  const [stages, setStages] = React.useState<TimelineStagesResponse | null>(null);
  const [stagesLoading, setStagesLoading] = React.useState(false);
  const [stagesError, setStagesError] = React.useState<unknown>(null);

  // Round 3 — collaboration thread (#4), lazy on the Thread tab.
  const [thread, setThread] = React.useState<ThreadMessage[] | null>(null);
  const [threadLoading, setThreadLoading] = React.useState(false);
  const [threadError, setThreadError] = React.useState<unknown>(null);
  const [threadBusyId, setThreadBusyId] = React.useState<string | null>(null);

  // Round 3 — tasks + activity (#4), lazy on the Thread tab alongside the thread.
  const [tasks, setTasks] = React.useState<CaseTaskItem[] | null>(null);
  const [tasksLoading, setTasksLoading] = React.useState(false);
  const [tasksError, setTasksError] = React.useState<unknown>(null);
  const [tasksBusyId, setTasksBusyId] = React.useState<string | null>(null);
  const [activity, setActivity] = React.useState<CaseActivityItem[] | null>(null);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const [activityError, setActivityError] = React.useState<unknown>(null);

  // Users for the assignee picker + @mention autocomplete (best-effort).
  const [pickUsers, setPickUsers] = React.useState<PickableUser[]>([]);

  const { username: currentUser, hasPermission } = useAuth();
  const canComment = useCan('cases', 'comment');
  const canWriteCase = useCan('cases', 'write');

  const [rationale, setRationale] = React.useState<CaseRationale | null>(null);
  const [rationaleLoading, setRationaleLoading] = React.useState(false);
  const [rationaleError, setRationaleError] = React.useState<unknown>(null);

  // Threat context (F11) — lazy.
  const [threat, setThreat] = React.useState<ThreatContextPanelData | null>(null);
  const [threatLoading, setThreatLoading] = React.useState(false);
  const [threatError, setThreatError] = React.useState<unknown>(null);

  // Run-a-playbook (F10): the playbook catalog + a pending pick + run state.
  const [playbooks, setPlaybooks] = React.useState<Playbook[]>([]);
  const [runPlaybookOpen, setRunPlaybookOpen] = React.useState(false);
  const [runPlaybookId, setRunPlaybookId] = React.useState('');
  const [runningPlaybook, setRunningPlaybook] = React.useState(false);

  // Embedded Case Manager: one reference-faithful top-right action surface. The
  // legacy Sheet keeps its existing toolbar/footer so the old Cases workflow is
  // backward-compatible while the new workspace stays deliberately uncluttered.
  const [takeActionOpen, setTakeActionOpen] = React.useState(false);

  // Pending lifecycle action (confirm dialog) + optional structured fields.
  const [pending, setPending] = React.useState<ActionDef | null>(null);
  const [note, setNote] = React.useState('');
  const [resolution, setResolution] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [actionAssignee, setActionAssignee] = React.useState('');
  const [actionTags, setActionTags] = React.useState<string[]>([]);
  const [actionTagDraft, setActionTagDraft] = React.useState('');
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
  // `caseFeedback` call after the deterministic close — never through `decide()` (#3).
  const [grading, setGrading] = React.useState<GradingDraft>(emptyGradingDraft());
  const [acting, setActing] = React.useState(false);

  // Reinvestigate.
  const [reinvestOpen, setReinvestOpen] = React.useState(false);
  const [reinvestModel, setReinvestModel] = React.useState('');
  const [reinvesting, setReinvesting] = React.useState(false);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);

  // Export.
  const [exporting, setExporting] = React.useState<'json' | 'md' | null>(null);

  // FP auto-close policy (best-effort).
  const [fpPolicy, setFpPolicy] = React.useState<FpPolicy>(null);
  // SLA policy for the header's advisory SLA reading (best-effort, #3-safe).
  const [slaPolicy, setSlaPolicy] = React.useState<SlaPolicy | null>(null);
  // Header popovers + the narrow-pane Details sheet (keyboard shortcuts open them).
  const [ownerOpen, setOwnerOpen] = React.useState(false);
  const [tagsOpen, setTagsOpen] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const detailsTitleRef = React.useRef<HTMLHeadingElement | null>(null);
  // The control that opened a lifecycle / editor dialog, so focus returns to it (CM-3).
  const actionOpenerRef = React.useRef<HTMLElement | null>(null);
  const takeActionTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);

  // Notify (manual send) — F5/Wave 4. Channels come from the loaded settings.
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
      if (activeIdRef.current !== id) return; // a newer case is loading — drop the stale result
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
    const preview = previewRef.current;
    if (preview && preview.case_id === id) setC(preview);
    setRationale(null);
    setRationaleError(null);
    setTriage(null);
    setTimeline(null);
    setTimelineError(null);
    setStages(null);
    setStagesError(null);
    setThread(null);
    setThreadError(null);
    setThreadBusyId(null);
    setTasks(null);
    setTasksLoading(false);
    setTasksError(null);
    setTasksBusyId(null);
    setActivity(null);
    setActivityLoading(false);
    setActivityError(null);
    // Threat context is lazy-loaded and guarded by `threat === null`; resetting it
    // (and its error) here is what makes the Threat tab refetch for the newly-opened
    // case instead of showing the previous case's IOC/MITRE data.
    setThreat(null);
    setThreatError(null);
    // The active tab is kept across case switches: an analyst browsing the queue on the
    // Timeline stays on the Timeline (Defender's ↑/↓ behaviour).
    void loadCase();
  }, [open, id, loadCase]);

  // Triage chips (#12) — eager so the overview header reflects the four honest
  // signals as soon as the case opens. Best-effort: a failure leaves the chips null
  // and the overview falls back to its legacy headline panels.
  const loadTriage = React.useCallback(async () => {
    if (!id) return;
    setTriageLoading(true);
    try {
      const res = await getTriage(id);
      if (activeIdRef.current !== id) return;
      setTriage(res.chips || null);
    } catch {
      if (activeIdRef.current === id) setTriage(null);
    } finally {
      if (activeIdRef.current === id) setTriageLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (open && id) void loadTriage();
  }, [open, id, loadTriage]);

  // Campaign membership (#51) — fetch the campaign this case belongs to, keyed on the
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

  // Users for the picker + @mention autocomplete (best-effort, once per open).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listPickableUsers().then((res) => {
      if (!cancelled) setPickUsers(res);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Typed ReAct timeline (#12) — lazy on the Investigation tab.
  const loadTimeline = React.useCallback(async () => {
    if (!id) return;
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

  // Lazy on the Investigation tab. `!timelineError` in the guard stops a failed fetch
  // from re-firing forever (the loading flag flips back to false on failure, which
  // would otherwise re-satisfy `timeline === null && !loading` and hammer the backend).
  // The Retry affordance still works — loadTimeline clears the error before refetching.
  React.useEffect(() => {
    if (open && tab === 'investigation' && timeline === null && !timelineLoading && !timelineError) {
      void loadTimeline();
    }
  }, [open, tab, timeline, timelineLoading, timelineError, loadTimeline]);

  const loadStages = React.useCallback(async () => {
    if (!id) return;
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

  // Lazy on the Timeline tab (same error-guard rationale as loadTimeline above).
  React.useEffect(() => {
    if (open && tab === 'timeline' && stages === null && !stagesLoading && !stagesError) {
      void loadStages();
    }
  }, [open, tab, stages, stagesLoading, stagesError, loadStages]);

  // ---- Collaboration: thread + tasks + activity (#4) -------------------- //
  const loadThread = React.useCallback(async () => {
    if (!id) return;
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

  const loadTasks = React.useCallback(async () => {
    if (!id) return;
    setTasksLoading(true);
    setTasksError(null);
    try {
      const res = await getTasks(id);
      if (activeIdRef.current !== id) return;
      setTasks(res.tasks || []);
    } catch (e) {
      // Keep the last authoritative snapshot mounted on a failed refresh. An initial
      // failure therefore remains `null` (not a dishonest successful empty list), while
      // a later failure can truthfully show the stale tasks beside a retry affordance.
      if (activeIdRef.current === id) setTasksError(e);
    } finally {
      if (activeIdRef.current === id) setTasksLoading(false);
    }
  }, [id]);

  const loadActivity = React.useCallback(async () => {
    if (!id) return;
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
  // / activity feed — the frame payload is never rendered (#9), it only triggers a
  // reload, and nothing here touches the case decision (#3). Trailing-debounced so a
  // burst of teammate/AI events collapses into one refetch instead of a fetch storm.
  const liveThreadTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveActivityTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRefreshThread = React.useCallback(() => {
    if (liveThreadTimer.current) clearTimeout(liveThreadTimer.current);
    liveThreadTimer.current = setTimeout(() => {
      void loadThread();
    }, 1200);
  }, [loadThread]);
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
      // works — each loader clears its own error before refetching). The independent
      // task/activity guards prevent a failed endpoint from retry-looping or hiding the
      // other collaboration surfaces.
      if (thread === null && !threadLoading && !threadError) void loadThread();
      if (tasks === null && !tasksLoading && !tasksError) void loadTasks();
      if (activity === null && !activityLoading && !activityError) void loadActivity();
    }
  }, [
    open,
    tab,
    thread,
    threadLoading,
    threadError,
    tasks,
    tasksLoading,
    tasksError,
    activity,
    activityLoading,
    activityError,
    loadThread,
    loadTasks,
    loadActivity,
  ]);

  // Thread mutation handlers — each calls the API then refreshes the thread +
  // activity (so an @mention/new event shows). #3-safe: posting never touches the
  // case decision (the backend enforces this).
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
        setThreadBusyId(null);
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
        setThreadBusyId(null);
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
        setThreadBusyId(null);
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
        setThreadBusyId(null);
      }
    },
    [id, loadThread],
  );

  // Task mutation handlers.
  const createTask = React.useCallback(
    async (title: string) => {
      if (!id) return;
      setTasksBusyId('__add__');
      try {
        await addTask(id, { title });
        await loadTasks();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not add the task.');
      } finally {
        setTasksBusyId(null);
      }
    },
    [id, loadTasks, loadActivity],
  );

  const setTaskStatus = React.useCallback(
    async (taskId: string, status: TaskStatus) => {
      if (!id) return;
      setTasksBusyId(taskId);
      try {
        await patchTask(id, taskId, { status });
        await loadTasks();
        void loadActivity();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not update the task.');
      } finally {
        setTasksBusyId(null);
      }
    },
    [id, loadTasks, loadActivity],
  );

  const addTaskLog = React.useCallback(
    async (taskId: string, note: string) => {
      if (!id) return;
      setTasksBusyId(taskId);
      try {
        await logTask(id, taskId, note);
        await loadTasks();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not log the note.');
      } finally {
        setTasksBusyId(null);
      }
    },
    [id, loadTasks],
  );

  const loadRationale = React.useCallback(async () => {
    if (!id) return;
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

  React.useEffect(() => {
    const needsRationale = tab === 'investigation' || presentation === 'embedded';
    if (open && needsRationale && rationale === null && !rationaleLoading && !rationaleError) {
      void loadRationale();
    }
  }, [open, tab, presentation, rationale, rationaleLoading, rationaleError, loadRationale]);

  const loadThreat = React.useCallback(async () => {
    if (!id) return;
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

  React.useEffect(() => {
    if (open && tab === 'threat' && threat === null && !threatLoading && !threatError) {
      void loadThreat();
    }
  }, [open, tab, threat, threatLoading, threatError, loadThreat]);

  // Playbook catalog for the run-a-playbook picker (best-effort).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getPlaybooks()
      .then((res) => {
        if (!cancelled) setPlaybooks(res.enabled ? res.playbooks ?? [] : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const runPlaybook = React.useCallback(async () => {
    const pid = runPlaybookId.trim();
    if (!pid) return;
    setRunningPlaybook(true);
    setError(null);
    try {
      const next = await api.cases.runPlaybook(id, pid);
      commitCase(next);
      setTakeActionOpen(false);
      setRunPlaybookOpen(false);
      setRunPlaybookId('');
      // The run is a re-investigation — invalidate the lazy tab payloads.
      setRationale(null);
      setThreat(null);
      setTimeline(null);
      setStages(null);
      void loadTriage();
      toast.success('Playbook applied — the case was re-investigated with it as context.');
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Could not run the playbook.',
      );
    } finally {
      setRunningPlaybook(false);
    }
  }, [id, runPlaybookId, loadTriage, commitCase]);

  // Models for the reinvestigate picker (best-effort).
  React.useEffect(() => {
    if (!open) return;
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
  }, [open]);

  // FP auto-close policy (best-effort).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getSettings()
      .then((res) => {
        if (cancelled) return;
        setFpPolicy((res?.prefs?.fp_auto_close as FpPolicy) || null);
        setSlaPolicy((res?.prefs?.sla as SlaPolicy | undefined) ?? null);
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
  }, [open]);

  const runNotify = React.useCallback(async () => {
    setNotifying(true);
    try {
      const res = await api.cases.notify(id, notifyChannelId || undefined);
      const okCount = res.sent.filter((s) => s.ok).length;
      const failCount = res.sent.length - okCount;
      if (res.sent.length === 0) {
        toast.message('No channels matched — nothing was sent.');
      } else if (failCount === 0) {
        toast.success(`Notification sent to ${okCount} channel(s).`);
      } else if (okCount === 0) {
        toast.error(`Notification failed (${res.sent[0]?.detail || 'see audit log'}).`);
      } else {
        toast.warning(`Sent to ${okCount}, ${failCount} failed.`);
      }
      setNotifyOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send notification.');
    } finally {
      setNotifying(false);
    }
  }, [id, notifyChannelId]);

  const resetActionFields = React.useCallback(() => {
    setNote('');
    setResolution('');
    setPriority('');
    setActionAssignee('');
    setActionTags([]);
    setActionTagDraft('');
    setActionDisposition('');
    setDispositionDeclared(false);
    setActionReason('');
    setGrading(emptyGradingDraft());
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
      // keeps its disposition badge) — it is just no longer pre-filled into the
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
      if (trimmedNote) input.note = trimmedNote;
      if (pending.fields.includes('resolution') && resolution) input.resolution = resolution;
      if (pending.fields.includes('assignee') && actionAssignee.trim()) {
        input.assignee = actionAssignee.trim();
      }
      if (pending.fields.includes('priority') && priority) input.priority = priority;
      if (pending.fields.includes('tags')) {
        const tags = Array.from(new Set(actionTags.map((t) => t.trim()).filter(Boolean)));
        if (tags.length) input.tags = tags;
      }
      if (pending.fields.includes('disposition') && actionDisposition) {
        input.disposition = actionDisposition;
        // Assert the INTENT separately from the value (G1). The backend applies the
        // disposition either way, but records it as independent analyst evidence only
        // on this flag — so a client that echoes a stored, model-derived disposition
        // cannot manufacture ground truth. Sent only when the analyst operated the
        // picker in this dialog.
        if (dispositionDeclared) input.disposition_declared = true;
      }
      if (pending.fields.includes('reason') && actionReason.trim()) {
        input.reason = actionReason.trim();
      }
      const next = await api.caseActionExec(id, input);
      commitCase(next);
      setPending(null);
      resetActionFields();
      // Completion feedback names the outcome that was recorded (Apple §16). A close or
      // resolve offers REOPEN for 8 s — the existing `reopen` analyst verb (#3). It is
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

      // Feedback-into-close (#10): grading the AI decision is a SEPARATE, best-effort
      // POST from the deterministic close above — decide()/apply() ran ONLY inside
      // `caseActionExec` (two distinct calls, #3). Fire it only for a grading action on a
      // case that carried an AI verdict to grade (skip NEEDS-noverdict / non-grading
      // actions); the assessment is DERIVED (agree/override) from the disposition↔verdict
      // diff by GradingFields and kept synced in `grading`. The typeof-guard keeps
      // callers/tests that don't wire `caseFeedback` working, and a rejected grading
      // never surfaces as a close failure.
      const gradedVerdictRaw = next.verdict ?? c?.verdict ?? '';
      const gradedVerdict = String(gradedVerdictRaw).trim().toLowerCase();
      // The analyst explicitly stated what actually happened. That is GROUND TRUTH and
      // it stands on its own: a case with no AI verdict has nothing to grade but its
      // confirmed outcome is exactly as real, and dropping it here would silently throw
      // away the one field `analyst_confirmed_outcome` can read (G1).
      const statedOutcome = Boolean(grading.actual_outcome);
      if (
        pending.fields.includes('grading') &&
        (statedOutcome || (gradedVerdict && gradedVerdict !== 'none')) &&
        typeof api.caseFeedback === 'function'
      ) {
        // Derive the agree/override assessment AT SUBMIT TIME from the disposition being
        // committed on close ↔ the AI verdict — do NOT trust `grading.assessment`. That
        // field is synced by an effect inside GradingFields, which is unmounted when the
        // analyst collapses the grading section; a later disposition change would then
        // POST a STALE assessment into the AI-eval loop. `confirm_fp` carries no
        // disposition picker: its committed outcome is FALSE_POSITIVE (mirrors the dialog).
        const committedDisposition =
          pending.key === 'confirm_fp' ? 'false_positive' : actionDisposition;
        const derived = deriveAgreement(gradedVerdictRaw, committedDisposition);
        // Only a match or an override is an agreement signal. A Needs-human hand-off the
        // analyst settled (`resolved`) or an outcome with no comparison (`none`) states no
        // agreement, so nothing is posted unless the analyst entered a grade themselves —
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
            // Grading stays best-effort — the close already SUCCEEDED in a separate
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
      // A failed lifecycle action is a MUTATION failure, not a case-load failure — use a
      // toast (like postMessage/notify) so we never mislabel it as "Could not load case".
      toast.error(e instanceof Error ? e.message : 'The action could not be completed.');
      setPending(null);
    } finally {
      setActing(false);
    }
  }, [
    pending,
    note,
    resolution,
    priority,
    actionAssignee,
    actionTags,
    actionDisposition,
    dispositionDeclared,
    actionReason,
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

  const runReinvestigate = React.useCallback(async () => {
    setReinvesting(true);
    setError(null);
    try {
      const input = reinvestModel.trim() ? { model: reinvestModel.trim() } : undefined;
      const next = await api.reinvestigateCase(id, input);
      commitCase(next);
      setTakeActionOpen(false);
      setReinvestOpen(false);
      setRationale(null);
      setTimeline(null);
      setStages(null);
      void loadTriage();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The reinvestigation could not be started.');
    } finally {
      setReinvesting(false);
    }
  }, [reinvestModel, id, loadTriage, commitCase]);

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

  const modelOptions = React.useMemo<Array<{ value: string; text: string }>>(() => {
    const out: Array<{ value: string; text: string }> = [];
    for (const [provider, list] of Object.entries(models?.providers || {})) {
      for (const m of list || []) {
        out.push({ value: m, text: `${m}  ·  ${provider}` });
      }
    }
    return out;
  }, [models]);

  // Open this case in a standalone browser tab. Both the legacy Cases sheet and the
  // embedded Case Manager understand the generic `caseId` hash query, so preserve the
  // current presentation's home instead of unexpectedly bouncing an inline analyst
  // back to the legacy table. Read-only — opening a tab never touches the decision (#3).
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

  // ---- keyboard shortcuts (CM-4/CM-3) -------------------------------------- //
  // A / C / E / H acknowledge, close, escalate or hold (each OPENS its dialog — every
  // mutation still goes through its dialog), R reinvestigate (always confirmed), M the
  // owner picker, T the tags editor, Alt+1…6 switch tabs. Active only while focus is NOT
  // in text entry and no menu, popover or dialog of this case is open.
  const shortcutStateRef = React.useRef({
    blocked: false,
    actions: [] as ActionDef[],
    canAssign: false,
    canTag: false,
  });
  const permittedForShortcuts = (() => {
    const plan = actionPlanForStatus(c?.status);
    return [plan.primary, plan.close, ...plan.overflow].filter(
      (action, index, actions): action is ActionDef =>
        Boolean(action) &&
        actions.findIndex((candidate) => candidate?.key === action?.key) === index &&
        hasPermission(ACTION_PERMISSION[action!.key].resource, ACTION_PERMISSION[action!.key].action),
    );
  })();
  const shownIsCurrent = Boolean(c && c.case_id === id);
  shortcutStateRef.current = {
    blocked:
      !shownIsCurrent ||
      loading ||
      acting ||
      pending !== null ||
      takeActionOpen ||
      reinvestOpen ||
      runPlaybookOpen ||
      notifyOpen ||
      ownerOpen ||
      tagsOpen ||
      detailsOpen,
    actions: permittedForShortcuts,
    canAssign: hasPermission('cases', 'assign'),
    canTag: hasPermission('cases', 'write'),
  };
  const openActionRef = React.useRef(openAction);
  openActionRef.current = openAction;

  React.useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const TAB_KEYS: Array<typeof tab> = ['overview', 'timeline', 'investigation', 'threat', 'collab', 'chat'];
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      // Text entry, a Select (typeahead), a menu or a radio group consumes letters itself;
      // an open picker owns the keyboard. One key must never do two things.
      if (shortcutBlocked(event)) return;
      // A different modal surface (a palette, another dialog) owns the keyboard.
      if (presentation === 'embedded' && document.querySelector('[role="dialog"][data-state="open"]')) return;
      const state = shortcutStateRef.current;
      if (state.blocked) return;
      if (event.altKey) {
        const digit = /^Digit([1-6])$/.exec(event.code);
        if (!digit) return;
        event.preventDefault();
        setTab(TAB_KEYS[Number(digit[1]) - 1]);
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
      else if (key === 'r') {
        event.preventDefault();
        actionOpenerRef.current = takeActionTriggerRef.current;
        setReinvestModel('');
        setReinvestOpen(true);
      } else if (key === 'm' && state.canAssign) {
        event.preventDefault();
        setOwnerOpen(true);
      } else if (key === 't' && state.canTag) {
        event.preventDefault();
        setTagsOpen(true);
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

  const actionPlan = actionPlanForStatus(c?.status);
  const permittedLifecycleActions = permittedForShortcuts;
  const outcome = c ? caseOutcome(c) : null;
  const busy = loading || acting || !shownIsCurrent;
  const canClosePrimary =
    hasPermission(ACTION_PERMISSION[actionPlan.primary.key].resource, ACTION_PERMISSION[actionPlan.primary.key].action);
  const canCloseSecondary = actionPlan.close
    ? hasPermission(ACTION_PERMISSION[actionPlan.close.key].resource, ACTION_PERMISSION[actionPlan.close.key].action)
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
  const mitreCount = Array.isArray(c?.mitre) ? c!.mitre!.length : 0;
  const traceSteps = timeline?.spans?.length ?? null;
  const messageCount = thread ? visibleMessageCount(thread) : null;
  const openTasks = tasks ? tasks.filter((t) => t.status !== 'done').length : null;
  const rail = c && outcome ? (
    <FactsRail
      c={c}
      outcome={outcome}
      triage={triage}
      slaPolicy={slaPolicy}
      fpPolicy={fpPolicy}
      users={pickUsers}
      canAssign={hasPermission('cases', 'assign')}
      onCaseChange={commitCase}
      onSetDisposition={
        setDispositionAction ? () => openFromControl(setDispositionAction, takeActionTriggerRef.current) : undefined
      }
      onShowRelated={() => setTab('overview')}
    />
  ) : null;
  const tabTrigger = cn(EMBEDDED_TAB_TRIGGER, 'gap-1.5 text-xs');
  const restoreTo = (ref: React.RefObject<HTMLElement | null>) => (event: Event) => {
    const target = [ref.current, takeActionTriggerRef.current].find(
      (el): el is HTMLElement => Boolean(el && el.isConnected),
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
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
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            className="@container/case flex h-full min-h-0 flex-col"
            data-case-busy={busy ? 'true' : undefined}
          >
            {/* ------------------------------------------- sticky header (CM-2) */}
            <div
              ref={headerRef}
              data-testid="case-detail-header"
              className={cn(
                materialBar,
                'relative z-10 shrink-0 px-4 pt-3 sm:px-5 lg:px-6',
                presentation === 'sheet' && 'pr-14 sm:pr-14 lg:pr-14',
              )}
            >
              <LoadingBar
                active={loading && Boolean(c)}
                size="sm"
                label="Loading case"
                className="absolute inset-x-0 top-0 rounded-none"
              />
              {/* Line 1: the title and the actions share ONE row when the whole title fits
                  beside them; when it does not (a long title in the default 1280 pane, a
                  phone) the actions WRAP to their own row and the title takes the full
                  width — it is never squeezed to a few characters or to nothing. The title
                  cell's flex basis is its natural width (`flex-auto`), which is what the
                  wrap decision is made on. Below a 56rem pane the title is a single line
                  (full title on hover and in its accessible name) and the secondary Close
                  folds into the Take action menu (casemanager.md §4.1). Line 2: the meta
                  row, full width. */}
              <header className="flex flex-wrap items-start gap-x-3 gap-y-2" data-testid="case-title-row">
                <div className="min-w-0 max-w-full flex-auto" data-testid="case-title-cell">
                  {/* UNTRUSTED title — plain text node. The full title is in the accessible
                      name and the hover title when it clamps. The SAME heading element is
                      rendered while the case loads (visually hidden, "Loading case"), so the
                      sheet can focus it on open and keep that focus when the case arrives —
                      never an icon button whose tooltip would then open by itself (CM-9). */}
                  <h2
                    ref={titleRef}
                    tabIndex={-1}
                    title={c ? c.title || c.case_id : undefined}
                    data-case-title
                    className={cn(
                      'truncate text-lg font-semibold leading-8 tracking-tight text-foreground outline-none',
                      '@[56rem]/case:line-clamp-2 @[56rem]/case:whitespace-normal @[56rem]/case:text-xl @[56rem]/case:leading-snug',
                      !c && 'sr-only',
                      c && !shownIsCurrent && 'opacity-60',
                    )}
                  >
                    {c ? c.title || c.case_id : 'Loading case'}
                  </h2>
                </div>

                <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5 @[48rem]/case:gap-2">
                  {c && actionPlan.close && canCloseSecondary ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="hidden h-8 @[56rem]/case:inline-flex"
                      disabled={busy}
                      aria-keyshortcuts="C"
                      onClick={(event) => openFromControl(actionPlan.close!, event.currentTarget)}
                    >
                      <Check className="h-4 w-4" aria-hidden />
                      {actionPlan.close.label}
                    </Button>
                  ) : null}
                  {c && canClosePrimary ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          className="h-8"
                          data-testid="case-primary-action"
                          disabled={busy}
                          aria-keyshortcuts={shortcutFor(actionPlan.primary.key) ?? undefined}
                          onClick={(event) => openFromControl(actionPlan.primary, event.currentTarget)}
                        >
                          {React.createElement(actionPlan.primary.icon, { className: 'h-4 w-4' })}
                          {actionPlan.primary.label}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{actionPlan.primary.help}</TooltipContent>
                    </Tooltip>
                  ) : null}

                  <DropdownMenu open={takeActionOpen} onOpenChange={setTakeActionOpen}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        ref={takeActionTriggerRef}
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={!c}
                      >
                        <Zap className="h-4 w-4" aria-hidden />
                        Take action
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" sideOffset={8} className="w-72">
                      <DropdownMenuLabel>Case actions</DropdownMenuLabel>
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
                      <DropdownMenuLabel>Investigation</DropdownMenuLabel>
                      <DropdownMenuItem
                        disabled={reinvesting || busy}
                        aria-keyshortcuts="R"
                        onSelect={() => {
                          actionOpenerRef.current = takeActionTriggerRef.current;
                          setTakeActionOpen(false);
                          setReinvestModel('');
                          setReinvestOpen(true);
                        }}
                      >
                        <Zap className="h-4 w-4" />
                        <span className="flex-1">Reinvestigate</span>
                        <MenuShortcut>R</MenuShortcut>
                      </DropdownMenuItem>
                      {hasPermission('playbooks', 'run') ? (
                        <DropdownMenuItem
                          disabled={runningPlaybook || busy}
                          onSelect={() => {
                            actionOpenerRef.current = takeActionTriggerRef.current;
                            setTakeActionOpen(false);
                            setRunPlaybookId('');
                            setRunPlaybookOpen(true);
                          }}
                        >
                          <BookOpen className="h-4 w-4" />
                          Run a playbook
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
                            setTakeActionOpen(false);
                            setOwnerOpen(true);
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
                            setTakeActionOpen(false);
                            setTagsOpen(true);
                          }}
                        >
                          <TagIcon className="h-4 w-4" />
                          <span className="flex-1">Edit tags</span>
                          <MenuShortcut>T</MenuShortcut>
                        </DropdownMenuItem>
                      ) : null}

                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Share and export</DropdownMenuLabel>
                      <DropdownMenuItem
                        onSelect={() => {
                          setTakeActionOpen(false);
                          openInNewTab();
                        }}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open in new tab
                      </DropdownMenuItem>
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

                  {/* The facts rail folds into a side sheet in a narrow pane. */}
                  <Button
                    ref={detailsTriggerRef}
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 @[60rem]/case:hidden"
                    disabled={!c}
                    aria-label="Details"
                    onClick={() => setDetailsOpen(true)}
                  >
                    <PanelRight className="h-4 w-4" aria-hidden />
                    <span className="hidden @[48rem]/case:inline">Details</span>
                  </Button>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 @[48rem]/case:px-3"
                        aria-label="Share"
                        onClick={() => void shareCase()}
                      >
                        <Share2 className="h-4 w-4" aria-hidden />
                        <span className="hidden @[48rem]/case:inline">Share</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Copy a link to this case</TooltipContent>
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
              {c ? (
                <>
                  {outcome ? (
                    <CaseHeaderMeta
                      c={c}
                      outcome={outcome}
                      campaign={campaign}
                      onOpenCampaign={onNavigate ? () => onNavigate('campaigns') : undefined}
                      users={pickUsers}
                      currentUser={currentUser}
                      canAssign={hasPermission('cases', 'assign') && shownIsCurrent}
                      canTag={canWriteCase && shownIsCurrent}
                      slaPolicy={slaPolicy}
                      onCaseChange={commitCase}
                      ownerOpen={ownerOpen}
                      onOwnerOpenChange={setOwnerOpen}
                      tagsOpen={tagsOpen}
                      onTagsOpenChange={setTagsOpen}
                    />
                  ) : null}
                </>
              ) : (
                <div className="space-y-2 py-1">
                  <Skeleton className="h-6 w-72 max-w-full" />
                  <Skeleton className="h-4 w-96 max-w-full" />
                </div>
              )}

              {c ? (
                <div className="-mx-1 mt-2 overflow-x-auto px-1">
                  <TabsList className="h-auto w-max min-w-full justify-start gap-4 rounded-none border-0 bg-transparent p-0">
                    <TabsTrigger value="overview" className={tabTrigger} aria-keyshortcuts="Alt+1">
                      Overview
                    </TabsTrigger>
                    <TabsTrigger value="timeline" className={tabTrigger} aria-keyshortcuts="Alt+2">
                      Timeline
                    </TabsTrigger>
                    <TabsTrigger value="investigation" className={tabTrigger} aria-keyshortcuts="Alt+3">
                      Investigation
                      {traceSteps ? <TabCount label="steps">{traceSteps}</TabCount> : null}
                    </TabsTrigger>
                    <TabsTrigger value="threat" className={tabTrigger} aria-keyshortcuts="Alt+4">
                      Threat context
                      {mitreCount ? <TabCount label="MITRE techniques">{mitreCount}</TabCount> : null}
                    </TabsTrigger>
                    <TabsTrigger value="collab" className={tabTrigger} aria-keyshortcuts="Alt+5">
                      Collaboration
                      {messageCount ? <TabCount label="messages">{messageCount}</TabCount> : null}
                      {openTasks ? <TabCount label="open tasks">{openTasks} open</TabCount> : null}
                    </TabsTrigger>
                    <TabsTrigger value="chat" className={tabTrigger} aria-keyshortcuts="Alt+6">
                      Chat
                      {/* A case chat answer being written, unread, waiting or failed (SPEC D13). */}
                      <CaseChatActivityGlyph caseId={c.case_id} className="ml-1.5" />
                    </TabsTrigger>
                  </TabsList>
                </div>
              ) : (
                <div className="h-3" />
              )}
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
                          fpPolicy={fpPolicy}
                          triage={triage}
                          triageLoading={triageLoading}
                          rationale={rationale}
                          rationaleLoading={rationaleLoading}
                          rationaleError={rationaleError}
                          onRetryRationale={loadRationale}
                          onOpenInvestigation={() => setTab('investigation')}
                          onOpenTab={(next) => setTab(next)}
                          onNavigate={onNavigate}
                          presentation="case-manager"
                          onSetDisposition={
                            setDispositionAction && shownIsCurrent
                              ? (opener) => openFromControl(setDispositionAction, opener)
                              : undefined
                          }
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="timeline" className="mt-0">
                      <TabPanelMotion>
                        {/* The "what happened" six-stage narrative, alone (task 5). */}
                        <TimelinePanel
                          stages={stages}
                          stagesLoading={stagesLoading}
                          stagesError={stagesError}
                          onRetryStages={loadStages}
                          presentation="case-manager"
                          onOpenInvestigation={() => setTab('investigation')}
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="investigation" className="mt-0">
                      <TabPanelMotion>
                        {/* Decision first, then the AI assessment, inputs, evidence, and the
                            collapsed full trace (CM-6). */}
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
                          presentation="case-manager"
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="threat" className="mt-0">
                      <TabPanelMotion>
                        <ThreatContextPanel
                          c={c}
                          panel={threat}
                          loading={threatLoading}
                          error={threatError}
                          onRetry={loadThreat}
                          onNavigate={onNavigate}
                          presentation="case-manager"
                        />
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
                          tasks={tasks}
                          tasksLoading={tasksLoading}
                          tasksError={tasksError}
                          tasksBusyId={tasksBusyId}
                          activity={activity}
                          activityLoading={activityLoading}
                          activityError={activityError}
                          users={pickUsers}
                          currentUser={currentUser}
                          canComment={canComment}
                          canWrite={canWriteCase}
                          onRetryThread={loadThread}
                          onRetryTasks={loadTasks}
                          onRetryActivity={loadActivity}
                          onPost={(text) => void postMessage(text)}
                          onReply={(parentId, text) => void postMessage(text, parentId)}
                          onEdit={(msgId, text) => void editMessage(msgId, text)}
                          onDelete={(msgId) => void removeMessage(msgId)}
                          onReact={(msgId, emoji, remove) => void reactMessage(msgId, emoji, remove)}
                          onAddTask={(title) => void createTask(title)}
                          onTaskStatus={(taskId, status) => void setTaskStatus(taskId, status)}
                          onTaskLog={(taskId, note) => void addTaskLog(taskId, note)}
                          onAssigned={(next) => {
                            commitCase(next);
                            if (activity !== null) void loadActivity();
                          }}
                          liveCaseId={id}
                          onLiveThread={liveRefreshThread}
                          onLiveActivity={liveRefreshActivity}
                          presentation="case-manager"
                        />
                      </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="chat" className="mt-0 h-full min-h-0">
                      <TabPanelMotion className="h-full min-h-0">
                        <ChatTab
                          c={c}
                          onNavigate={onNavigate}
                          onClose={onClose}
                          presentation="case-manager"
                        />
                      </TabPanelMotion>
                    </TabsContent>
                  </div>
                )}
              </div>

              {/* The facts rail — every tab, from a 60rem pane (CM-6). */}
              {rail ? (
                <div
                  data-testid="case-facts-column"
                  className={cn(
                    'hidden w-[19rem] shrink-0 overflow-y-auto border-l border-border/70 px-4 py-5 @[60rem]/case:block',
                    !shownIsCurrent && 'opacity-60',
                  )}
                >
                  {rail}
                </div>
              ) : null}
            </div>
          </Tabs>
        </MotionProvider>
      </CaseDetailSurface>

      {/* Narrow panes: the same facts in a NON-blocking side sheet (no scrim). */}
      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen} modal={false}>
        <SheetContent
          side="right"
          size="default"
          className="overflow-y-auto p-5"
          aria-describedby={undefined}
          // Open on the sheet's heading, never its first help tip (whose explainer would
          // then pop open by itself); close back to the Details button, not <body> — the
          // sheet is opened from state and non-modal, so Radix has no trigger to return to.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            detailsTitleRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
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
          {rail}
        </SheetContent>
      </Sheet>

      {/* Editors launched from the Take action menu. Detached dialogs (not nested
          popovers), so Select focus/keyboard behaviour stays reliable after the menu
          closes; focus returns to the control that opened them. */}
      <Dialog open={reinvestOpen} onOpenChange={setReinvestOpen}>
        <DialogContent className="sm:max-w-md" onCloseAutoFocus={restoreTo(actionOpenerRef)}>
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
              Investigation cost to date {fmtMoney(c?.token_cost)}. Re-running spends more
              tokens and replaces the current verdict, confidence, and rationale.
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
            <Button variant="ghost" onClick={() => setReinvestOpen(false)} disabled={reinvesting}>
              Cancel
            </Button>
            <Button onClick={() => void runReinvestigate()} disabled={reinvesting}>
              {reinvesting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Reinvestigate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={runPlaybookOpen} onOpenChange={setRunPlaybookOpen}>
        <DialogContent className="sm:max-w-md" onCloseAutoFocus={restoreTo(actionOpenerRef)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              Run a playbook
            </DialogTitle>
            <DialogDescription>
              Re-investigate with a trusted operator playbook. It can recommend; deterministic
              code still owns the close or escalate decision.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Costs tokens</AlertTitle>
            <AlertDescription>
              This re-runs the LLM pipeline and may replace the verdict and rationale. It never
              changes lifecycle status on its own.
            </AlertDescription>
          </Alert>
          <div className="space-y-1.5">
            <Label className="text-xs">Playbook</Label>
            {playbooks.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No playbooks are loaded. Add Markdown runbooks on the backend.
              </p>
            ) : (
              <Select
                value={runPlaybookId || undefined}
                onValueChange={setRunPlaybookId}
                disabled={runningPlaybook}
              >
                <SelectTrigger aria-label="Playbook">
                  <SelectValue placeholder="Select a playbook…" />
                </SelectTrigger>
                <SelectContent>
                  {playbooks.map((playbook) => (
                    <SelectItem key={playbook.id} value={playbook.id}>
                      {/* Operator-authored name → plain text. */}
                      {playbook.name || playbook.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRunPlaybookOpen(false)} disabled={runningPlaybook}>
              Cancel
            </Button>
            <Button onClick={() => void runPlaybook()} disabled={runningPlaybook || !runPlaybookId.trim()}>
              {runningPlaybook ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run playbook
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --------------------------------------- confirm / close-with-disposition */}
      <ConfirmActionDialog
        pending={pending}
        acting={acting}
        onClose={closeAction}
        onSubmit={() => void runAction(false)}
        onSubmitAndNext={onAdvance ? () => void runAction(true) : undefined}
        returnFocusTo={actionOpenerRef}
        focusAfterSubmit={resolveDialogFocus}
        note={note}
        onNoteChange={setNote}
        resolution={resolution}
        onResolutionChange={setResolution}
        priority={priority}
        onPriorityChange={setPriority}
        assignee={actionAssignee}
        onAssigneeChange={setActionAssignee}
        tags={actionTags}
        onTagsChange={setActionTags}
        tagDraft={actionTagDraft}
        onTagDraftChange={setActionTagDraft}
        disposition={actionDisposition}
        onDispositionChange={declareDisposition}
        currentDisposition={c?.disposition ?? null}
        reason={actionReason}
        onReasonChange={setActionReason}
        verdict={c?.verdict ?? null}
        confidence={c?.confidence ?? null}
        grading={grading}
        onGradingChange={setGrading}
      />

      {/* Notify (manual send) dialog — F5/Wave 4. Picks one configured channel or
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
              {notifying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};

/** A quiet count beside a tab label ("Investigation 18"). */
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
