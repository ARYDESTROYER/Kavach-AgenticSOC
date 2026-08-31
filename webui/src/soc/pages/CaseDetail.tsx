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
  Bell,
  BookOpen,
  Bot,
  Check,
  Download,
  ExternalLink,
  FileText,
  Globe,
  History,
  MessageSquare,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Send,
  Share2,
  Shield,
  Users,
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
  ThreatContextPanel as ThreatContextPanelData,
} from '@/lib/types';
import { errorMessage } from '@/lib/errorMessage';
import { fmtMoney, humanizeAge } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Sheet, SheetContent } from '@/ui/sheet';
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
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/ui/popover';
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
import { LoadingState } from '@/design-system';

import {
  StatusBadge,
  DispositionBadge,
  AutoClosedBadge,
  SeverityBadge,
  severityBand,
} from '@/soc/components/badges';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
import { Can, useCan } from '@/soc/components/Can';
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
import { CampaignChip } from '@/soc/pages/Campaigns';

import {
  type ActionDef,
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
import {
  deriveAgreement,
  emptyGradingDraft,
  gradingToFeedbackInput,
  type GradingDraft,
} from './casedetail/grading';

// Re-export the co-located API types so existing importers keep working.
export type { ThreadMessage };

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
  children: React.ReactNode;
}> = ({ presentation, open, onClose, children }) => {
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
}

export const CaseDetail: React.FC<CaseDetailProps> = ({
  caseId,
  onClose,
  onNavigate,
  presentation = 'sheet',
  onCaseChange,
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

  const commitCase = React.useCallback(
    (next: Case) => {
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

  React.useEffect(() => {
    if (!open) return;
    // Reset all per-case lazy state when the case changes / opens.
    setC(null);
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
    setTab('overview');
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

  const runAction = React.useCallback(async () => {
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
        const freshAssessment = derived.kind === 'none' ? undefined : derived.assessment;
        const feedbackBody = gradingToFeedbackInput(
          { ...grading, assessment: freshAssessment },
          currentUser || undefined,
        );
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
        const blob = new Blob([res.content], {
          type: res.content_type || 'application/octet-stream',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || `case-${id}.${fmt === 'md' ? 'md' : 'json'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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

  if (!open) return null;

  const actionPlan = actionPlanForStatus(c?.status);
  const permittedLifecycleActions = [
    actionPlan.primary,
    actionPlan.close,
    ...actionPlan.overflow,
  ].filter(
    (action, index, actions): action is ActionDef =>
      Boolean(action) &&
      actions.findIndex((candidate) => candidate?.key === action?.key) === index &&
      hasPermission(
        ACTION_PERMISSION[action!.key].resource,
        ACTION_PERMISSION[action!.key].action,
      ),
  );
  const headerSeverity = c
    ? severityBand(c.severity_band) ?? severityBand(c.risk_score)
    : null;

  return (
    <TooltipProvider delayDuration={200}>
      <CaseDetailSurface presentation={presentation} open={open} onClose={onClose}>
          <MotionProvider>
          <div className="flex h-full min-h-0 flex-col">
            {/* ----------------------------------------------------- header */}
            <header
              className={cn(
                'flex shrink-0 items-start gap-4',
                presentation === 'sheet' &&
                  'border-b border-border bg-card px-6 py-4',
                presentation === 'embedded' &&
                  'flex-col bg-background px-4 pb-3 pt-4 sm:flex-row sm:flex-wrap sm:px-5 lg:px-6',
              )}
            >
              <div
                className={cn(
                  presentation === 'sheet' && 'contents',
                  presentation === 'embedded' &&
                    'flex min-w-0 w-full flex-1 items-start gap-3 sm:w-auto sm:min-w-[26rem]',
                )}
              >
              <div
                className={cn(
                  'mt-0.5 flex shrink-0 items-center justify-center',
                  presentation === 'sheet' &&
                    'h-9 w-9 rounded-md bg-primary/10 text-primary',
                  presentation === 'embedded' &&
                    'h-9 w-9 rounded-[3px] border border-critical/30 bg-critical/10',
                )}
              >
                {presentation === 'embedded' && headerSeverity === 'critical' ? (
                  <AlertTriangle className="h-5 w-5 text-critical-text" />
                ) : (
                  <Shield className="h-5 w-5 text-primary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {loading || !c ? (
                  <Skeleton className="h-6 w-72" />
                ) : (
                  <>
                    <div
                      className={cn(
                        'flex items-center gap-2',
                        presentation === 'sheet' ? 'flex-wrap' : 'min-w-0 flex-nowrap',
                      )}
                    >
                      {/* Human-facing display id (F7) — falls back to case_id. */}
                      <span
                        title={presentation === 'embedded' ? c.case_number || c.case_id : undefined}
                        className={cn(
                          'font-mono font-semibold',
                          presentation === 'sheet' && 'shrink-0 text-xs text-primary',
                          presentation === 'embedded' &&
                            'block min-w-0 flex-1 truncate text-xl uppercase tracking-tight text-foreground',
                        )}
                      >
                        {c.case_number || c.case_id}
                      </span>
                      {presentation === 'embedded' ? (
                        <SeverityBadge
                          severity={headerSeverity}
                          labelSuffix="severity"
                          className="h-5 shrink-0 rounded-[3px] px-2 text-2xs uppercase tracking-wider"
                        />
                      ) : null}
                      <DemoBadge show={isDemoCase(c)} className="text-2xs" />
                    </div>
                    <h2
                      className={cn(
                        'font-semibold tracking-tight text-foreground',
                        presentation === 'sheet' && 'mt-0.5 truncate text-lg',
                        presentation === 'embedded' &&
                          'mt-1.5 line-clamp-2 text-lg text-muted-foreground',
                      )}
                    >
                      {/* UNTRUSTED title — plain text node. */}
                      {c.title || c.case_id}
                    </h2>
                    {presentation === 'sheet' ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <StatusBadge status={c.status} />
                      <DispositionBadge disposition={c.disposition ?? null} />
                      {/* Round-7 #11 — self-hiding: shows only when the AI auto-closed
                          this case (terminal status + decision_by === 'agent'). */}
                      <AutoClosedBadge status={c.status} decisionBy={c.decision_by} />
                      {typeof c.escalation_level === 'number' && c.escalation_level > 0 ? (
                        <Badge variant="critical" className="gap-1">
                          <Bell className="h-3 w-3" /> Escalated
                        </Badge>
                      ) : null}
                      {/* Campaign membership (#51) — plain text (#9); clicking deep-links
                          to the Campaigns surface. Renders nothing when uncampaigned. */}
                      {campaign ? (
                        <CampaignChip
                          campaign={campaign}
                          onOpen={onNavigate ? () => onNavigate('campaigns') : undefined}
                        />
                      ) : null}
                    </div>
                    ) : null}
                  </>
                )}
                {presentation === 'sheet' ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {c?.created_at ? (
                    <>Created {humanizeAge(c.created_at)}</>
                  ) : (
                    'Created —'
                  )}
                  {c?.updated_at ? <> · Updated {humanizeAge(c.updated_at)}</> : null}
                </p>
                ) : null}
              </div>
              </div>

              {/* Header icon actions. Sheet mode reserves room for Radix's built-in X;
                  embedded mode supplies its own explicit pane-close control. */}
              <div
                className={cn(
                  'flex shrink-0 items-center',
                  presentation === 'sheet' && 'pr-8',
                  presentation === 'embedded' &&
                    'ml-auto w-full justify-end gap-2 sm:w-auto',
                )}
              >
                {presentation === 'embedded' ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-[3px] px-3"
                      onClick={() => void shareCase()}
                    >
                      <Share2 className="h-4 w-4" />
                      Share
                    </Button>

                    <DropdownMenu open={takeActionOpen} onOpenChange={setTakeActionOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          className="h-8 rounded-[3px] px-3 shadow-elev1"
                          disabled={loading || acting}
                        >
                          <Zap className="h-4 w-4" />
                          Take Action
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        sideOffset={8}
                        className="w-72 rounded-[3px]"
                      >
                        <DropdownMenuLabel className="text-2xs uppercase tracking-wider">
                          Case actions
                        </DropdownMenuLabel>
                        {permittedLifecycleActions.map((action) => {
                          const Icon = action.icon;
                          return (
                            <DropdownMenuItem
                              key={action.key}
                              disabled={loading || acting}
                              onSelect={() => openAction(action)}
                            >
                              <Icon className="h-4 w-4" />
                              <span className="flex-1">{action.label}</span>
                            </DropdownMenuItem>
                          );
                        })}

                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-2xs uppercase tracking-wider">
                          Investigation
                        </DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={reinvesting || loading}
                          onSelect={() => {
                            setTakeActionOpen(false);
                            setReinvestModel('');
                            setReinvestOpen(true);
                          }}
                        >
                          <Zap className="h-4 w-4" />
                          Reinvestigate
                        </DropdownMenuItem>
                        {hasPermission('playbooks', 'run') ? (
                          <DropdownMenuItem
                            disabled={runningPlaybook || loading}
                            onSelect={() => {
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
                          Ask about this case
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="text-2xs uppercase tracking-wider">
                          Share &amp; export
                        </DropdownMenuLabel>
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
                          disabled={exporting !== null || loading}
                          onSelect={() => {
                            setTakeActionOpen(false);
                            void runExport('json');
                          }}
                        >
                          <Download className="h-4 w-4" />
                          Export JSON
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={exporting !== null || loading}
                          onSelect={() => {
                            setTakeActionOpen(false);
                            void runExport('md');
                          }}
                        >
                          <FileText className="h-4 w-4" />
                          Export Markdown report
                        </DropdownMenuItem>
                        {hasPermission('cases', 'write') ? (
                          <DropdownMenuItem
                            disabled={loading}
                            onSelect={() => {
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

                    <Button
                      variant="outline"
                      size="icon"
                      className="hidden h-9 w-9 rounded-[3px] xl:inline-flex"
                      aria-label="Back to case queue"
                      onClick={onClose}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                {/* Reinvestigate (popover) */}
                <Popover open={reinvestOpen} onOpenChange={setReinvestOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={reinvesting || loading}
                          aria-label="Reinvestigate"
                          onClick={() => setReinvestModel('')}
                        >
                          {reinvesting ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Zap className="h-4 w-4" />
                          )}
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Reinvestigate</TooltipContent>
                  </Tooltip>
                  <PopoverContent align="end" className="w-80">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Search className="h-4 w-4 text-primary" />
                        <span className="text-sm font-semibold text-foreground">
                          Re-run the investigation
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Forces a fresh AI investigation. This runs the LLM pipeline and may
                        take a few seconds.
                      </p>
                      <Alert variant="warning" className="py-2">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertTitle className="text-xs">
                          Costs tokens and overwrites the verdict
                        </AlertTitle>
                        <AlertDescription className="text-xs">
                          Investigation cost to date {fmtMoney(c?.token_cost)}. Re-running
                          spends more tokens and replaces this case&apos;s current verdict,
                          confidence, and rationale.
                        </AlertDescription>
                      </Alert>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Model</Label>
                        <Select
                          value={reinvestModel || '__configured__'}
                          onValueChange={(v) =>
                            setReinvestModel(v === '__configured__' ? '' : v)
                          }
                          disabled={reinvesting}
                        >
                          <SelectTrigger className="h-8 text-xs" aria-label="Model">
                            <SelectValue placeholder="Use configured model" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__configured__">
                              Use configured model
                            </SelectItem>
                            {modelOptions.map((m) => (
                              <SelectItem key={m.value} value={m.value}>
                                {m.text}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReinvestOpen(false)}
                          disabled={reinvesting}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void runReinvestigate()}
                          disabled={reinvesting}
                        >
                          {reinvesting ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                          Reinvestigate
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>

                {/* Run a playbook (CONTEXT-ONLY re-investigation) — gated by playbooks:run */}
                <Can resource="playbooks" action="run">
                  <Popover open={runPlaybookOpen} onOpenChange={setRunPlaybookOpen}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={runningPlaybook || loading}
                            aria-label="Run a playbook"
                            onClick={() => setRunPlaybookId('')}
                          >
                            {runningPlaybook ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <BookOpen className="h-4 w-4" />
                            )}
                          </Button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      <TooltipContent>Run a playbook</TooltipContent>
                    </Tooltip>
                    <PopoverContent align="end" className="w-80">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <BookOpen className="h-4 w-4 text-primary" />
                          <span className="text-sm font-semibold text-foreground">
                            Run a playbook
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Re-investigates this case with the chosen playbook injected as
                          TRUSTED operator procedure. The playbook can only{' '}
                          <span className="font-medium text-foreground">recommend</span> — the
                          close / escalate decision is still made by deterministic code.
                        </p>
                        <Alert variant="warning" className="py-2">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle className="text-xs">Costs tokens</AlertTitle>
                          <AlertDescription className="text-xs">
                            This re-runs the LLM pipeline and may replace the verdict /
                            rationale. It never changes the lifecycle status on its own.
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
                              <SelectTrigger className="h-8 text-xs" aria-label="Playbook">
                                <SelectValue placeholder="Select a playbook…" />
                              </SelectTrigger>
                              <SelectContent>
                                {playbooks.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {/* Operator-authored name → plain text. */}
                                    {p.name || p.id}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRunPlaybookOpen(false)}
                            disabled={runningPlaybook}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void runPlaybook()}
                            disabled={runningPlaybook || !runPlaybookId.trim()}
                          >
                            {runningPlaybook ? (
                              <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                            Run playbook
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </Can>

                {/* Refresh */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Refresh case"
                      disabled={loading}
                      onClick={() => void loadCase()}
                    >
                      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh</TooltipContent>
                </Tooltip>

                {/* Ask about this case → jump to chat tab */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Ask about this case"
                      onClick={() => setTab('chat')}
                    >
                      <MessageSquare className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Ask about this case</TooltipContent>
                </Tooltip>

                {/* History → the Timeline tab ("what happened" narrative) */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Timeline"
                      onClick={() => setTab('timeline')}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Timeline</TooltipContent>
                </Tooltip>

                {/* Investigation → the AI assessment + deterministic decision + full trace */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Investigation"
                      onClick={() => setTab('investigation')}
                    >
                      <Bot className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Investigation</TooltipContent>
                </Tooltip>

                {/* Open this case in a new browser tab (deep-link to the Cases surface). */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Open in new tab"
                      onClick={openInNewTab}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open in new tab</TooltipContent>
                </Tooltip>

                {/* Export */}
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Export case"
                          disabled={exporting !== null || loading}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Export</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void runExport('json')}>
                      <FileText className="h-4 w-4" />
                      JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void runExport('md')}>
                      <FileText className="h-4 w-4" />
                      Markdown report
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Notify (manual send) — gated by cases:write */}
                <Can resource="cases" action="write">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Notify"
                        disabled={loading}
                        onClick={() => {
                          setNotifyChannelId('');
                          setNotifyOpen(true);
                        }}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Notify</TooltipContent>
                  </Tooltip>
                </Can>
                  </>
                )}
              </div>
            </header>

            {/* ----------------------------------------------------- body */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

              {loading || !c ? (
                <LoadingState
                  label="Loading case"
                  description="Retrieving the case record and its evidence."
                  layout="page"
                  shape="page"
                  className="px-6"
                />
              ) : (
                <Tabs
                  value={tab}
                  onValueChange={(v) => setTab(v as typeof tab)}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div
                    className={cn(
                      'shrink-0 overflow-x-auto border-b border-border',
                      presentation === 'sheet' ? 'px-6' : 'px-4 sm:px-5 lg:px-6',
                      presentation === 'sheet' && 'pt-3',
                    )}
                  >
                    <TabsList
                      className={cn(
                        'w-max min-w-full justify-start',
                        presentation === 'embedded' &&
                          'h-auto gap-4 rounded-none border-0 bg-transparent p-0',
                      )}
                    >
                      <TabsTrigger
                        value="overview"
                        className={cn(
                          'gap-1.5',
                          'text-xs',
                          presentation === 'embedded' &&
                            'rounded-none border-b-2 border-transparent px-0 py-2.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none',
                        )}
                      >
                        {presentation === 'sheet' ? <FileText className="h-3.5 w-3.5" /> : null}
                        Overview
                      </TabsTrigger>
                      <TabsTrigger
                        value="timeline"
                        className={cn(
                          'gap-1.5',
                          'text-xs',
                          presentation === 'embedded' &&
                            'rounded-none border-b-2 border-transparent px-0 py-2.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none',
                        )}
                      >
                        <History className="h-3.5 w-3.5" /> Timeline
                      </TabsTrigger>
                      <TabsTrigger
                        value="investigation"
                        className={cn(
                          'gap-1.5',
                          'text-xs',
                          presentation === 'embedded' &&
                            'rounded-none border-b-2 border-transparent px-0 py-2.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none',
                        )}
                      >
                        <Bot className="h-3.5 w-3.5" /> Investigation
                      </TabsTrigger>
                      <TabsTrigger
                        value="threat"
                        className={cn(
                          'gap-1.5',
                          'text-xs',
                          presentation === 'embedded' &&
                            'rounded-none border-b-2 border-transparent px-0 py-2.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none',
                        )}
                      >
                        {presentation === 'sheet' ? <Globe className="h-3.5 w-3.5" /> : null}
                        Threat context
                      </TabsTrigger>
                      <TabsTrigger
                        value="collab"
                        className={cn(
                          'gap-1.5',
                          'text-xs',
                          presentation === 'embedded' &&
                            'rounded-none border-b-2 border-transparent px-0 py-2.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none',
                        )}
                      >
                        <Users className="h-3.5 w-3.5" /> Collaboration
                      </TabsTrigger>
                      <TabsTrigger
                        value="chat"
                        className={cn(
                          'gap-1.5',
                          'text-xs',
                          presentation === 'embedded' &&
                            'rounded-none border-b-2 border-transparent px-0 py-2.5 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none',
                        )}
                      >
                        <MessageSquare className="h-3.5 w-3.5" /> Chat
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  <div
                    ref={panelScrollRef}
                    className={cn(
                      'min-h-0 flex-1',
                      presentation === 'embedded' && tab === 'chat'
                        ? 'overflow-hidden'
                        : 'overflow-y-auto',
                    )}
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
                        onNavigate={onNavigate}
                        presentation={presentation === 'embedded' ? 'case-manager' : 'default'}
                      />
                     </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="timeline" className="mt-0">
                     <TabPanelMotion>
                      {/* The clean "what happened" six-stage narrative, alone (task 5).
                          `stages` is fetched on first visit to this tab by the lazy effect
                          above. */}
                      <TimelinePanel
                        stages={stages}
                        stagesLoading={stagesLoading}
                        stagesError={stagesError}
                        onRetryStages={loadStages}
                        presentation={presentation === 'embedded' ? 'case-manager' : 'default'}
                        onOpenInvestigation={() => setTab('investigation')}
                      />
                     </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="investigation" className="mt-0">
                     <TabPanelMotion>
                      {/* AI assessment → pinned deterministic DecisionCard + a collapsible
                          full ReAct trace (task 5). rationale/timeline are fetched on first
                          visit by the lazy effects above; DecisionCard reads its
                          policy_clause off the timeline. */}
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
                        presentation={presentation === 'embedded' ? 'case-manager' : 'default'}
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
                        presentation={presentation === 'embedded' ? 'case-manager' : 'default'}
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
                        presentation={presentation === 'embedded' ? 'case-manager' : 'default'}
                      />
                     </TabPanelMotion>
                    </TabsContent>
                    <TabsContent value="chat"
                      className={cn(
                        'mt-0',
                        presentation === 'embedded' && 'h-full min-h-0',
                      )}
                    >
                     <TabPanelMotion
                       className={cn(presentation === 'embedded' && 'h-full min-h-0')}
                     >
                      <ChatTab
                        c={c}
                        onNavigate={onNavigate}
                        onClose={onClose}
                        presentation={presentation === 'embedded' ? 'case-manager' : 'default'}
                      />
                     </TabPanelMotion>
                    </TabsContent>
                  </div>
                </Tabs>
              )}
            </div>

            {/* ----------------------------------------------------- footer
                ONE clear primary CTA (context-dependent on status) + a secondary
                "Close case" (unified Close-with-disposition) + an overflow "More"
                menu for the rest — instead of a row of equally-weighted buttons.
                Every control is <Can>-gated by its action's grant. */}
            {c && presentation === 'sheet' ? (
              <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
                <Button variant="ghost" size="sm" onClick={onClose}>
                  <X className="h-4 w-4" /> Dismiss
                </Button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {/* Overflow — the remaining contextual actions. */}
                  {(() => {
                    const overflow = actionPlan.overflow.filter((a) =>
                      hasPermission(ACTION_PERMISSION[a.key].resource, ACTION_PERMISSION[a.key].action),
                    );
                    if (overflow.length === 0) return null;
                    return (
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={loading || acting}
                                aria-label="More actions"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                                More
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>More actions</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="w-56">
                          {overflow.map((a) => {
                            const Icon = a.icon;
                            return (
                              <DropdownMenuItem
                                key={a.key}
                                disabled={loading || acting}
                                onSelect={() => openAction(a)}
                              >
                                <Icon className="h-4 w-4" />
                                <span className="flex-1">{a.label}</span>
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  })()}

                  {/* Unified Close-with-disposition — secondary (unless it's the
                      primary, i.e. resolved cases, where actionPlan.close is null). */}
                  {actionPlan.close ? (
                    <Can
                      resource={ACTION_PERMISSION[actionPlan.close.key].resource}
                      action={ACTION_PERMISSION[actionPlan.close.key].action}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={loading || acting}
                            onClick={() => openAction(actionPlan.close!)}
                            aria-label={`${actionPlan.close.label} — ${actionPlan.close.help}`}
                          >
                            <Check className="h-4 w-4" />
                            {actionPlan.close.label}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{actionPlan.close.help}</TooltipContent>
                      </Tooltip>
                    </Can>
                  ) : null}

                  {/* Primary CTA — the single filled, context-dependent action. */}
                  <Can
                    resource={ACTION_PERMISSION[actionPlan.primary.key].resource}
                    action={ACTION_PERMISSION[actionPlan.primary.key].action}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant={actionPlan.primary.variant === 'outline' ? 'default' : actionPlan.primary.variant}
                          disabled={loading || acting}
                          onClick={() => openAction(actionPlan.primary)}
                          aria-label={`${actionPlan.primary.label} — ${actionPlan.primary.help}`}
                        >
                          {React.createElement(actionPlan.primary.icon, { className: 'h-4 w-4' })}
                          {actionPlan.primary.label}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{actionPlan.primary.help}</TooltipContent>
                    </Tooltip>
                  </Can>
                </div>
              </footer>
            ) : null}
          </div>
          </MotionProvider>
      </CaseDetailSurface>

      {/* Embedded-only editors launched from the single Take Action menu. They are
          detached dialogs (not nested popovers), so Select focus/keyboard behavior
          remains reliable after the Radix menu closes. */}
      {presentation === 'embedded' ? (
        <>
          <Dialog open={reinvestOpen} onOpenChange={setReinvestOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  Re-run the investigation
                </DialogTitle>
                <DialogDescription>
                  Force a fresh AI investigation. This runs the LLM pipeline and may
                  take a few seconds.
                </DialogDescription>
              </DialogHeader>
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Costs tokens and overwrites the verdict</AlertTitle>
                <AlertDescription>
                  Investigation cost to date {fmtMoney(c?.token_cost)}. Re-running spends
                  more tokens and replaces the current verdict, confidence, and rationale.
                </AlertDescription>
              </Alert>
              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <Select
                  value={reinvestModel || '__configured__'}
                  onValueChange={(value) =>
                    setReinvestModel(value === '__configured__' ? '' : value)
                  }
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
                <Button
                  variant="ghost"
                  onClick={() => setReinvestOpen(false)}
                  disabled={reinvesting}
                >
                  Cancel
                </Button>
                <Button onClick={() => void runReinvestigate()} disabled={reinvesting}>
                  {reinvesting ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Reinvestigate
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={runPlaybookOpen} onOpenChange={setRunPlaybookOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-primary" />
                  Run a playbook
                </DialogTitle>
                <DialogDescription>
                  Re-investigate with a trusted operator playbook. It can recommend;
                  deterministic code still owns the close or escalate decision.
                </DialogDescription>
              </DialogHeader>
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Costs tokens</AlertTitle>
                <AlertDescription>
                  This re-runs the LLM pipeline and may replace the verdict and rationale.
                  It never changes lifecycle status on its own.
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
                          {playbook.name || playbook.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setRunPlaybookOpen(false)}
                  disabled={runningPlaybook}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void runPlaybook()}
                  disabled={runningPlaybook || !runPlaybookId.trim()}
                >
                  {runningPlaybook ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Run playbook
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      {/* --------------------------------------- confirm / close-with-disposition */}
      <ConfirmActionDialog
        pending={pending}
        acting={acting}
        onClose={closeAction}
        onSubmit={() => void runAction()}
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
        grading={grading}
        onGradingChange={setGrading}
      />

      {/* Notify (manual send) dialog — F5/Wave 4. Picks one configured channel or
          all enabled; the send is fire-and-forget and never changes the case. */}
      <Dialog open={notifyOpen} onOpenChange={setNotifyOpen}>
        <DialogContent className="max-w-md">
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
              <Select value={notifyChannelId || '__all__'} onValueChange={(v) => setNotifyChannelId(v === '__all__' ? '' : v)}>
                <SelectTrigger aria-label="Channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All enabled channels</SelectItem>
                  {notifyChannels.map((c) => (
                    <SelectItem key={c.id} value={c.id} disabled={!c.enabled}>
                      {c.name} · {c.type}
                      {c.enabled ? '' : ' (disabled)'}
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

export default CaseDetail;
