/**
 * App shell for the SOC console — a slim left ICON RAIL + a top bar + the routed
 * content slot.
 *
 * - Rail: the registry-derived `NavSidebar` (collapsible groups Overview / Triage /
 *   Intelligence / Analytics / Notifications / Platform, per nav.ts ← registry.FEATURES),
 *   with disclosure groups + fly-outs when collapsed; the active item is highlighted
 *   with a quiet accent surface + edge rail. Width toggles with Cmd/Ctrl-B (persisted).
 * - Top bar: product breadcrumb ("<Product> / <Page>" using OUR product name from
 *   branding), and on the right a theme toggle, version badge, a health pill
 *   (polls /api/health, debounced), an optional user chip + logout, and a Cmd-K
 *   hint that opens a cmdk command palette for navigation.
 * - Content: `bg-canvas`, the single gutter/vertical-rhythm authority for every
 *   routed page (per-page width is capped/centered by `<PageContainer variant>`),
 *   re-keyed on the page id so it replays `animate-fade-in` on every route change.
 *
 * Health-poll behaviour mirrors the legacy Shell: poll every 15s, only flip to
 * "unreachable" after 2 consecutive failures, and label Healthy / Store degraded
 * / Backend unreachable. UNTRUSTED branding text renders as plain text only.
 */
import * as React from 'react';
import {
  Moon,
  Sun,
  CheckCircle2,
  AlertTriangle,
  Database,
  Loader2,
  XCircle,
  LogOut,
  UserCircle2,
  ShieldCheck,
  MonitorSmartphone,
  Monitor,
  Palette,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  Search,
  RefreshCw,
  GitBranch,
  ExternalLink,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/ui/button';
import { badgeVariants } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { initialsFrom } from '@/lib/avatar';
import { humanizeToken } from '@/lib/format';
import type { AccountProfile, BuildInfoResponse, HealthResponse } from '@/lib/types';
import type { DeployedReleaseManifest } from '@/lib/deployment-update';
import {
  upstreamReleaseNotice,
  type UpstreamReleaseNotice,
} from '@/lib/upstream-release';
import {
  CONSOLE_RELEASE_IDENTITY,
  resolveReleasePresentation,
  type ReleaseIdentity,
} from '@/lib/release';
import { useTheme } from './theme';
import { usePrefs } from './prefs';
import { useDemo } from './demo';
import { DemoBanner } from './components/DemoBanner';
import { AnnouncerProvider } from './components/announcer';
import { CommandPalette } from './components/CommandPalette';
import { GlassSurface } from './components/GlassSurface';
import { NavSidebar, useNavPrefs } from './components/NavSidebar';
import { NotificationBell } from './components/NotificationBell';
import { ConfirmDialog } from './components/ConfirmDialog';
import {
  SystemUpdateControl,
  systemUpdateTriggerPresentation,
} from './components/SystemUpdateControl';
import { useAuth } from './auth';
import { useDeploymentUpdate } from './hooks/useDeploymentUpdate';
import { useDeploymentUpgrade } from './hooks/useDeploymentUpgrade';
import { useUpstreamReleaseUpdates } from './hooks/useUpstreamReleaseUpdates';
import { useHasUnsavedChanges } from './hooks/useDirtyDraft';
import { useIsMobile } from './hooks/useMediaQuery';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import { JobMonitor } from './jobs/JobMonitor';
import { navItem, navLabel, navParentOf, type PageId } from './nav';
import type { Navigate } from './router';
// TYPE-ONLY import (elided at build → zero runtime import): motion.dev must NEVER ride
// the eager App/AppShell first-paint graph, so RouteMotion is reached purely through the
// DYNAMIC `import()` below. See soc/components/motion/* + bundle-first-paint.test.ts.
import type { RouteMotionProps } from './components/motion/RouteMotion';

/** The single content inset (gutter + vertical rhythm) applied to every routed page. */
const CONTENT_INSET = 'mx-auto w-full min-w-0 px-4 py-6 sm:px-6 lg:px-8 2xl:px-12';

/**
 * Self-update is deliberately stricter than the Console's auth-off/RBAC-off
 * compatibility behavior: only an authenticated built-in super_admin with the
 * explicit server grant may even probe or render the installation control.
 */
export function canUseSystemUpdateControl(
  authEnabled: boolean,
  role: string | null,
  hasPermission: (resource: string, action: string) => boolean,
): boolean {
  return authEnabled && role === 'super_admin' && hasPermission('system_updates', 'read');
}

/** Auto-activation is allowed only for the exact signed Stable pair reported by the supervisor. */
export function supervisedTargetMatchesRunningStable(
  current: { version: string; channel: string; commit_sha: string } | null,
  target: DeployedReleaseManifest | null,
): boolean {
  if (!current || !target) return false;
  const serverCommit = current.commit_sha.trim();
  const targetCommit = target.commitSha.trim();
  return (
    current.channel === 'stable' &&
    target.channel === 'stable' &&
    target.version === current.version &&
    serverCommit !== '' &&
    targetCommit !== '' &&
    serverCommit.toLowerCase() !== 'unknown' &&
    targetCommit.toLowerCase() !== 'unknown' &&
    targetCommit === serverCommit
  );
}

/** Keep the verified manual activation action after the one automatic attempt. */
export function shouldShowDeploymentActivationFallback(
  target: DeployedReleaseManifest | null,
  needsBrowserActivation: boolean,
  supervisedUpdateActive: boolean,
  activationAttemptedJobId: string | null,
  supervisedJobId: string | null,
): boolean {
  return Boolean(
    target &&
      !supervisedUpdateActive &&
      (!needsBrowserActivation ||
        (supervisedJobId !== null && activationAttemptedJobId === supervisedJobId)),
  );
}

export interface AppShellProps {
  /** The currently-active page id (drives the rail highlight + breadcrumb). */
  page: PageId;
  /** Navigate to another page (rail clicks + command palette). */
  onNavigate: Navigate;
  /** When auth is enabled + authenticated, the signed-in username. */
  username?: string | null;
  /** Called when the user clicks "Log out" (only rendered when `username` set). */
  onLogout?: () => void;
  /** The routed page content. */
  children: React.ReactNode;
}

type HealthTone = 'success' | 'warning' | 'critical' | 'muted';

interface HealthView {
  tone: HealthTone;
  /** Short pill label. */
  label: string;
  icon: typeof CheckCircle2;
  /** One-line summary (store_type etc.) — plain text. */
  detail: string;
  /** A bold popover heading. */
  title: string;
  /** Multi-line plain-language help: meaning + consequence + how to fix. */
  help: string;
}

/** The in-memory ES fallback's class name (own-state runs in memory, no persistence). */
const isInMemoryStore = (t?: string): boolean => t === 'InMemoryESClient';

export function healthView(health: HealthResponse | null, err: boolean): HealthView {
  if (err) {
    return {
      tone: 'critical',
      label: 'Backend unreachable',
      icon: XCircle,
      detail: 'Cannot reach the backend API',
      title: 'Backend unreachable',
      help:
        'The console cannot reach the backend API. The agentic pipeline, cases and ' +
        'settings are unavailable until it returns.\n\n' +
        'How to fix: confirm the Agentic SOC backend is running and reachable; ' +
        'see docs/TROUBLESHOOTING.md.',
    };
  }
  // Before the first /api/health resolves (health === null and not yet failed twice)
  // we know NOTHING about the store — show a neutral "Checking…" note, never the
  // alarming amber "State store unreachable" fall-through below (which would flash on
  // every fresh load and mislabel the first ~15s of a total backend outage).
  if (health === null) {
    return {
      tone: 'muted',
      label: 'Checking…',
      icon: Loader2,
      detail: 'Contacting backend',
      title: 'Checking backend health…',
      help: 'Waiting for the first /api/health response. The pill updates as soon as the backend replies.',
    };
  }
  const storeType = health?.store_type ?? 'unknown';
  // Prefer the truthfully named additive field. Older backends remain supported
  // through the compatibility alias until every deployed pair is upgraded.
  const stateStoreConnected = health?.state_store_connected ?? health?.es_connected;
  // The in-memory ES fallback pings OK (reports es_connected:true) but does NOT
  // persist — surface it as a muted, informative note rather than a green "Healthy".
  if (stateStoreConnected && isInMemoryStore(storeType)) {
    return {
      tone: 'muted',
      label: 'In-memory store',
      icon: Database,
      detail: `Store: ${storeType}`,
      title: 'In-memory store (not persistent)',
      help:
        "The platform's own state store is running in-memory (Elasticsearch/SQL " +
        'not reachable). Cases, cursors, audit and settings will NOT persist across ' +
        'a backend restart.\n\n' +
        'How to fix: set STATE_BACKEND=elasticsearch or postgres and configure ' +
        'connectivity (see DEPLOY.md).',
    };
  }
  if (stateStoreConnected) {
    return {
      tone: 'success',
      label: 'Healthy',
      icon: CheckCircle2,
      detail: `Store: ${storeType}`,
      title: 'Healthy',
      help: `Own-state store connected and persisting. Store: ${storeType}.`,
    };
  }
  return {
    tone: 'warning',
    label: 'State store unreachable',
    icon: AlertTriangle,
    detail: `Store: ${storeType}`,
    title: 'State store unreachable',
    help:
      `The platform's own state store (${storeType}) is not reachable. New cases, ` +
      'cursors and audit may fail to persist.\n\n' +
      'How to fix: check the store connection and credentials; ' +
      'see docs/TROUBLESHOOTING.md.',
  };
}

const TONE_PILL: Record<HealthTone, string> = {
  success: 'border-success/40 text-success-text',
  warning: 'border-warning/40 text-warning-text',
  critical: 'border-critical/40 text-critical-text',
  muted: 'border-border text-muted-foreground',
};

/** Poll /api/health every 15s, debouncing transient failures. */
function useHealth(): { health: HealthResponse | null; err: boolean } {
  const [health, setHealth] = React.useState<HealthResponse | null>(null);
  const [err, setErr] = React.useState(false);
  const failRef = React.useRef(0);

  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (!alive) return;
        failRef.current = 0;
        setHealth(h);
        setErr(false);
      } catch {
        if (!alive) return;
        failRef.current += 1;
        if (failRef.current >= 2) setErr(true);
      }
    };
    void poll();
    const t = window.setInterval(poll, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  return { health, err };
}

/**
 * Always-visible release badge. Its popover names both compiled Console provenance
 * and runtime backend provenance; a disagreement is conspicuous and can never render
 * Stable. Every value is rendered as plain text.
 */
export function ReleaseBadge({
  buildInfo,
  consoleIdentity = CONSOLE_RELEASE_IDENTITY,
}: {
  buildInfo?: BuildInfoResponse | null;
  consoleIdentity?: ReleaseIdentity;
}) {
  const release = resolveReleasePresentation(consoleIdentity, buildInfo);
  const tone = release.channel === 'stable' ? 'success' : 'warning';
  const ariaLabel = `Agentic SOC v${release.version}, ${release.contextLabel}${
    release.mismatch ? ', build identity mismatch' : ''
  }${release.provenanceComplete ? '' : ', build provenance incomplete'}`;

  const row = (label: string, value: string) => (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-right font-mono text-foreground">{value}</dd>
    </div>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="release-badge"
          aria-label={ariaLabel}
          className={cn(
            badgeVariants({ variant: tone }),
            'h-7 shrink-0 gap-1.5 font-normal tabular-nums',
          )}
        >
          <span>v{release.version}</span>
          <span className="hidden min-[360px]:inline" aria-hidden="true">·</span>
          <span className="hidden min-[360px]:inline">{release.channelLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 text-xs">
        <div>
          <p className="font-semibold text-foreground">{release.contextLabel}</p>
          <p className="mt-0.5 text-muted-foreground">
            {release.channel === 'stable'
              ? 'Explicitly promoted from the protected main release path.'
              : 'Testing is the fail-safe default for source, integration, and preview builds.'}
          </p>
        </div>

        {release.mismatch ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-warning-text">
            Console and backend build identities differ. This session is treated as Testing.
          </p>
        ) : null}

        {!release.provenanceComplete ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-warning-text">
            Build provenance is incomplete. This installation stays Testing and cannot offer a
            verified update until both images are rebuilt with commit and build-time stamps.
          </p>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="font-semibold text-foreground">Console build</p>
          <dl className="space-y-1.5">
            {row('Version', release.console.version)}
            {row('Channel', release.console.channel === 'stable' ? 'Stable' : 'Testing')}
            {row('Commit', release.console.commitSha)}
            {row('Built', release.console.buildTime)}
          </dl>
        </div>

        {release.backend ? (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="font-semibold text-foreground">Backend build</p>
            <dl className="space-y-1.5">
              {row('Version', release.backend.version)}
              {row('Channel', release.backend.channel === 'stable' ? 'Stable' : 'Testing')}
              {row('Commit', release.backend.commitSha)}
              {row('Built', release.backend.buildTime)}
            </dl>
          </div>
        ) : (
          <p className="border-t border-border pt-3 text-muted-foreground">
            Backend build-info is unavailable; showing the immutable Console build stamp.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Activate an already-deployed, backend-matched Console build after confirmation. */
export function DeploymentUpdateButton({
  target,
  activating,
  hasUnsavedChanges,
  onActivate,
}: {
  target: DeployedReleaseManifest;
  activating: boolean;
  hasUnsavedChanges: boolean;
  onActivate: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const accessibleLabel = `Update Agentic SOC to v${target.version}`;
  const setDialogOpen = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        Agentic SOC v{target.version} is ready to update.
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            size="sm"
            data-testid="deployment-update-button"
            className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
            aria-label={accessibleLabel}
            disabled={activating}
            onClick={() => setOpen(true)}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', activating && 'animate-spin')} aria-hidden />
            <span className="hidden xl:inline">{activating ? 'Checking…' : 'Update'}</span>
            <span className="hidden 2xl:inline">v{target.version}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{accessibleLabel}</TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={open}
        onOpenChange={setDialogOpen}
        title={hasUnsavedChanges ? 'Save your changes first' : `Update to v${target.version}?`}
        description={
          hasUnsavedChanges ? (
            <span className="block">
              You have unsaved changes. Save or discard them before updating; this release will
              remain available when you are ready.
            </span>
          ) : (
            <span className="block space-y-2">
              <span className="block">
                Version v{target.version} is already deployed and verified against the backend.
              </span>
              <span className="block">
                Updating reloads this browser tab; backend jobs continue. Save any unfinished
                draft before continuing.
              </span>
            </span>
          )
        }
        confirmLabel="Update now"
        cancelLabel={hasUnsavedChanges ? 'Return to work' : 'Keep working'}
        hideConfirm={hasUnsavedChanges}
        onConfirm={onActivate}
      />
    </>
  );
}

/**
 * A source-only notice. It deliberately offers no activate/install action: a branch
 * observation is not a deployed release and cannot satisfy the same-origin preflight.
 */
export function UpstreamSourceNoticeButton({ notice }: { notice: UpstreamReleaseNotice }) {
  const { candidate, kind } = notice;
  const versionLabel = candidate.version ? `v${candidate.version}` : 'a new revision';
  const accessibleLabel =
    kind === 'version'
      ? `New source version ${versionLabel} available on ${candidate.branch}`
      : `Source revision on ${candidate.branch} differs from this Console build`;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="upstream-source-notice"
              className="h-7 shrink-0 gap-1.5 border-warning/40 px-2.5 text-xs text-warning-text"
              aria-label={accessibleLabel}
            >
              <GitBranch className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden 2xl:inline">Source</span>
              <span>{kind === 'version' ? versionLabel : 'differs'}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{accessibleLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 text-xs">
        <div>
          <p className="font-semibold text-foreground">
            {kind === 'version' ? `${versionLabel} is available upstream` : 'Source revision differs'}
          </p>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            {kind === 'version'
              ? `The ${candidate.channel === 'stable' ? 'Stable' : 'Testing'} branch publishes a newer version than this Console build.`
              : `The configured ${candidate.channel === 'stable' ? 'Stable' : 'Testing'} branch currently points to a different commit than this Console build.`}{' '}
            It has not been deployed here yet.
          </p>
        </div>
        <dl className="space-y-1.5 border-y border-border py-3">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Branch</dt>
            <dd className="break-all text-right font-mono text-foreground">{candidate.branch}</dd>
          </div>
          {candidate.version ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono text-foreground">{candidate.version}</dd>
            </div>
          ) : null}
          {candidate.commit_sha ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Commit</dt>
              <dd className="font-mono text-foreground">{candidate.commit_sha.slice(0, 12)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="leading-relaxed text-muted-foreground">
          Review and deploy through your normal release pipeline. The Update button appears
          only after a matching Console and backend are already deployed and healthy.
        </p>
        {candidate.commit_url ? (
          <Button asChild variant="outline" size="sm" className="w-full">
            <a href={candidate.commit_url} target="_blank" rel="noreferrer">
              Review source commit
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Best-effort fetch of the signed-in user's profile (avatar + display name) so the
 * shell user chip reflects it. Only runs when auth is on + a username is present;
 * any failure leaves `profile` null and the chip falls back to initials + username.
 */
function useAccountProfile(active: boolean): AccountProfile | null {
  const [profile, setProfile] = React.useState<AccountProfile | null>(null);
  React.useEffect(() => {
    if (!active) {
      setProfile(null);
      return undefined;
    }
    let alive = true;
    void (async () => {
      try {
        const p = await api.account.get();
        if (alive) setProfile(p);
      } catch {
        if (alive) setProfile(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [active]);
  return profile;
}

/** Small round avatar (image + initials fallback) used in the shell user chip. */
export const UserAvatar: React.FC<{ src?: string; name: string; className?: string }> = ({
  src,
  name,
  className,
}) => {
  const [broken, setBroken] = React.useState(false);
  // Re-sync when the source changes (e.g. a profile refetch after the user updates
  // their picture): a one-time onError must not permanently pin the initials fallback
  // for a NEW, valid URL.
  React.useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      // onError is a broken-image fallback (swap to initials), not a user
      // interaction — the rule flags any handler on a non-interactive element.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className={cn('h-6 w-6 rounded-full border border-border object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary',
        className,
      )}
      aria-hidden
    >
      {initialsFrom(name)}
    </span>
  );
};

/**
 * The signed-in user chip — an avatar + display name that opens a menu with the
 * profile, security, and a destructive log-out. Reflects the live profile
 * (avatar/display_name) when available; falls back to the username + initials. All
 * text is user-set → rendered as PLAIN text (#9).
 */
const UserMenu: React.FC<{
  username: string;
  profile: AccountProfile | null;
  onNavigate: Navigate;
  onLogout?: () => void;
}> = ({ username, profile, onNavigate, onLogout }) => {
  const display = (profile?.display_name || username).trim();
  const role = profile?.role ? humanizeToken(String(profile.role)) : '';
  const { themeMode, setThemeMode } = usePrefs();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-2 rounded-md border border-border/80 bg-card py-1 pl-1 pr-2 text-xs',
            'transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          aria-label="Open account menu"
        >
          <UserAvatar src={profile?.avatar} name={display} />
          <span className="hidden max-w-[140px] truncate font-medium lg:inline">{display}</span>
          <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground lg:inline" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-2.5 py-2.5 text-foreground">
          <UserAvatar src={profile?.avatar} name={display} className="h-8 w-8 text-xs" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{display}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {role ? `${role} · @${username}` : `@${username}`}
            </span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onNavigate('account')}>
          <UserCircle2 aria-hidden />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNavigate('security')}>
          <ShieldCheck aria-hidden />
          Security &amp; two-factor
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNavigate('sessions')}>
          <MonitorSmartphone aria-hidden />
          Sessions &amp; activity
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Per-user theme (Wave 7): persisted to the user's prefs. 'system' follows the
            organization default theme when one is set, otherwise the device (Round-6 §18 —
            mirrors the CustomizationSection copy; the org-default cascade lives in
            stores/user_prefs.py). */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Palette aria-hidden />
            Appearance
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={themeMode}
              onValueChange={(v) => setThemeMode(v as 'light' | 'dark' | 'system')}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="mr-2 size-4" aria-hidden />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="mr-2 size-4" aria-hidden />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="mr-2 size-4" aria-hidden />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {/* Accurate System-mode copy (Round-6 §18): matches the org-default cascade
                and the CustomizationSection helper text — never the bare "follows the OS". */}
            <p className="max-w-[220px] px-2 pb-1 pt-1.5 text-xs leading-snug text-muted-foreground">
              “System” follows the organization default theme when one is set, otherwise
              your device setting.
            </p>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {onLogout ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onLogout}
              className="text-critical focus:text-critical [&>svg]:text-critical"
            >
              <LogOut aria-hidden />
              Log out
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const AppShell: React.FC<AppShellProps> = ({
  page,
  onNavigate,
  username,
  onLogout,
  children,
}) => {
  const { isDark, branding } = useTheme();
  const { setThemeMode } = usePrefs();
  // The header toggle flips light↔dark AND persists the choice to the user's prefs
  // (Wave 7), so it survives a reload + follows the user across devices.
  const toggleTheme = React.useCallback(
    () => setThemeMode(isDark ? 'light' : 'dark'),
    [isDark, setThemeMode],
  );
  const { health, err } = useHealth();
  const { authEnabled, role, hasPermission } = useAuth();
  const deploymentUpdate = useDeploymentUpdate();
  const checkDeployedRelease = deploymentUpdate.checkNow;
  const activateDeployedRelease = deploymentUpdate.activate;
  const deployedReleaseTarget = deploymentUpdate.target;
  const deployedReleaseActivating = deploymentUpdate.activating;
  // Self-update is intentionally stricter than ordinary backwards-compatible RBAC:
  // auth must be ON and the principal must be the built-in platform owner. The
  // backend repeats this check, requires a registered current session + fresh auth,
  // and remains authoritative if the Console state is stale.
  const canReadSystemUpdates = canUseSystemUpdateControl(authEnabled, role, hasPermission);
  const canApplySystemUpdates =
    canReadSystemUpdates && hasPermission('system_updates', 'apply');
  const canRollbackSystemUpdates =
    canReadSystemUpdates && hasPermission('system_updates', 'rollback');
  const deploymentUpgrade = useDeploymentUpgrade({ enabled: canReadSystemUpdates });
  const supervisedJobId = deploymentUpgrade.job?.job_id ?? null;
  const supervisedUpdateActive = Boolean(
    deploymentUpgrade.job &&
      ['queued', 'running', 'rolling_back'].includes(deploymentUpgrade.job.status),
  );
  const supervisedCurrent = deploymentUpgrade.status?.current ?? null;
  const needsBrowserActivation = deploymentUpgrade.needsBrowserActivation;
  const upstreamUpdates = useUpstreamReleaseUpdates();
  const buildInfo = deploymentUpdate.buildInfo;
  const hasUnsavedChanges = useHasUnsavedChanges();
  const [activationAttemptedJobId, setActivationAttemptedJobId] = React.useState<string | null>(null);
  const { active: demoActive, refresh: refreshDemo } = useDemo();
  const profile = useAccountProfile(Boolean(username));
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [compactControlsOpen, setCompactControlsOpen] = React.useState(false);
  const paletteReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const mobileNavRef = React.useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const reducedMotion = usePrefersReducedMotion();
  const releasePresentation = resolveReleasePresentation(CONSOLE_RELEASE_IDENTITY, buildInfo);
  const sourceNotice = releasePresentation.mismatch
    ? null
    : upstreamReleaseNotice(upstreamUpdates.data, {
        version: releasePresentation.version,
        channel: releasePresentation.channel,
        commitSha: releasePresentation.console.commitSha,
      });
  const showSourceNotice = Boolean(
    sourceNotice &&
      !deploymentUpdate.target &&
      deploymentUpgrade.status?.release_discovery.state !== 'candidate_observed' &&
      !deploymentUpgrade.status?.active_job,
  );
  const updatePresentation = systemUpdateTriggerPresentation(deploymentUpgrade);
  const keepSystemUpdateDirectOnMobile =
    updatePresentation.priority === 'actionable' || deploymentUpgrade.progressOpen;
  const showSystemUpdateDirect =
    canApplySystemUpdates && (!isMobile || keepSystemUpdateDirectOnMobile);
  const showSystemUpdateInCompactControls =
    canApplySystemUpdates &&
    isMobile &&
    updatePresentation.visible &&
    !keepSystemUpdateDirectOnMobile;
  const showDeploymentUpdate = Boolean(
    deploymentUpdate.target &&
      shouldShowDeploymentActivationFallback(
        deploymentUpdate.target,
        deploymentUpgrade.needsBrowserActivation,
        supervisedUpdateActive,
        activationAttemptedJobId,
        supervisedJobId,
      ),
  );

  const openPalette = React.useCallback((opener?: HTMLElement | null) => {
    const active =
      opener ??
      (document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null);
    paletteReturnFocusRef.current = active;
    setPaletteOpen(true);
  }, []);
  const handlePaletteOpenChange = React.useCallback((open: boolean) => {
    setPaletteOpen(open);
    if (open) return;
    const returnTarget = paletteReturnFocusRef.current;
    paletteReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (returnTarget?.isConnected) returnTarget.focus();
    });
  }, []);

  // A successful supervisor job has updated the server-side pair, but this open tab
  // still runs the old hashed assets. Reuse the existing same-origin release verifier
  // before replacing the document; it preserves the exact hash route. One attempted
  // activation per durable job prevents a verification failure from turning into a
  // reload loop—the coherent-pair fallback action remains available for manual retry.
  React.useEffect(() => {
    if (!needsBrowserActivation || hasUnsavedChanges) return;
    void checkDeployedRelease();
  }, [checkDeployedRelease, needsBrowserActivation, hasUnsavedChanges]);
  React.useEffect(() => {
    const jobId = supervisedJobId;
    const current = supervisedCurrent;
    const target = deployedReleaseTarget;
    if (
      !jobId ||
      !current ||
      !target ||
      !needsBrowserActivation ||
      hasUnsavedChanges ||
      deployedReleaseActivating ||
      activationAttemptedJobId === jobId
    ) return;
    if (!supervisedTargetMatchesRunningStable(current, target)) return;
    setActivationAttemptedJobId(jobId);
    void activateDeployedRelease();
  }, [
    activateDeployedRelease,
    activationAttemptedJobId,
    deployedReleaseActivating,
    deployedReleaseTarget,
    hasUnsavedChanges,
    needsBrowserActivation,
    supervisedCurrent,
    supervisedJobId,
  ]);
  // Nav collapse + open-group state (shell-owned; hydrates synchronously from a
  // localStorage mirror to avoid a first-paint flash, then reconciles with the
  // server-side UserPrefs.misc and persists every change). See useNavPrefs.
  const { collapsed, toggleCollapsed, openGroups, toggleGroup, openGroup } = useNavPrefs();
  const mobileOpenGroups = React.useMemo(() => {
    const next = new Set(openGroups);
    const parent = navParentOf(page);
    if (parent && (parent.children?.length ?? 0) > 0) next.add(parent.id);
    return next;
  }, [openGroups, page]);

  const handleMobileNavOpenChange = React.useCallback(
    (open: boolean) => {
      // A direct route to a disclosure child (for example #/users) may restore with
      // its parent collapsed. Expand that trail before Radix moves focus so the
      // canonical aria-current leaf is mounted and keyboard users land on the page
      // they are actually viewing.
      if (open) {
        const parent = navParentOf(page);
        if (parent && (parent.children?.length ?? 0) > 0) openGroup(parent.id);
      }
      setMobileNavOpen(open);
    },
    [openGroup, page],
  );

  // A desktop rail permanently consumes 240px when expanded, which left a 390px
  // viewport with only ~150px of routed content and forced document-wide horizontal
  // scrolling. Below `md`, navigation is a true modal Sheet instead: zero layout
  // footprint while closed, full labelled destinations while open.
  const navigateFromMobile = React.useCallback(
    (id: PageId) => {
      setMobileNavOpen(false);
      onNavigate(id);
    },
    [onNavigate],
  );

  const navigateFromCompactControls = React.useCallback(
    (id: PageId) => {
      setCompactControlsOpen(false);
      onNavigate(id);
    },
    [onNavigate],
  );

  // After activating a destination, hand focus to the routed main landmark so a
  // collapsed-rail group flyout closes and keyboard/screen-reader users receive an
  // immediate, predictable starting point in the content they just opened.
  const navigateFromDesktop = React.useCallback(
    (id: PageId) => {
      onNavigate(id);
      window.requestAnimationFrame(() => {
        document.getElementById('socMain')?.focus();
      });
    },
    [onNavigate],
  );
  React.useEffect(() => {
    if (!isMobile) {
      setMobileNavOpen(false);
      setCompactControlsOpen(false);
    }
  }, [isMobile]);
  React.useEffect(() => {
    setMobileNavOpen(false);
    setCompactControlsOpen(false);
  }, [page]);

  // Refetch the demo status on every route change so the banner/badges stay fresh
  // even between the background poll ticks (cheap GET; inert when demo is off).
  React.useEffect(() => {
    void refreshDemo();
  }, [page, refreshDemo]);

  // ---- Route/page transitions (motion.dev, lazy) ------------------------------------
  // Progressive enhancement: the motion.dev layer is dynamically imported AFTER first
  // paint (never on the eager entry graph — that would break the <400 kB entry budget),
  // and the animated route wrapper is engaged only on an ACTUAL page navigation that
  // happens WHILE the chunk is already loaded. That keeps the initial landing page — and
  // any page shown when the chunk merely finishes resolving — on its cheap CSS
  // `animate-fade-in` with NO remount / no double data-fetch; from the first navigation
  // after motion is ready onward, AnimatePresence cross-fades page → page.
  const [RouteMotion, setRouteMotion] = React.useState<React.ComponentType<RouteMotionProps> | null>(
    null,
  );
  React.useEffect(() => {
    let alive = true;
    void import('./components/motion/RouteMotion').then((mod) => {
      if (alive) setRouteMotion(() => mod.RouteMotion);
    });
    return () => {
      alive = false;
    };
  }, []);
  // BUG FIX (motion #1): the render branch must NOT flip plain→motion merely because the
  // lazy chunk RESOLVED. Keying the branch on `Boolean(RouteMotion)` meant that when the
  // chunk arrived mid-session while a page was already displayed, React unmounted +
  // remounted that SAME page (losing its component state, double-firing mount effects,
  // re-fetching data). Instead, a monotonic `motionActive` latch flips to `true` ONLY at
  // the moment of a real navigation (`page` changed since the last render) AND only when
  // the chunk is already loaded then — never on the chunk resolving while the page is
  // unchanged. Both set-states run during render (React's supported "adjust state while
  // rendering" pattern; React discards the intermediate render and re-renders with the
  // updated state BEFORE committing), so the first motion-engaging navigation lands
  // straight in the motion branch with no plain→motion remount of the incoming page.
  const [prevPage, setPrevPage] = React.useState(page);
  const [motionActive, setMotionActive] = React.useState(false);
  if (page !== prevPage) {
    setPrevPage(page);
    // A real navigation just happened. Engage motion from now on IFF the chunk is loaded;
    // if it is not, stay plain — a later chunk resolution alone must never flip the branch.
    if (RouteMotion && !motionActive) setMotionActive(true);
  }
  const useMotionRoute = motionActive && Boolean(RouteMotion);

  // Product name for the breadcrumb prefix; falls back to a neutral default.
  const productName = branding.product_name?.trim() || branding.org_name?.trim() || 'Agentic SOC';
  const logoUrl = branding.logo_data_url?.trim() || '';
  const accountDisplay = (profile?.display_name || username || '').trim();
  const accountRole = profile?.role ? humanizeToken(String(profile.role)) : '';
  // Breadcrumb leaf label — resolves top-level items, disclosure children, and the
  // consolidated sub-pages (navItem only knows top-level rail items).
  const pageLabel = navItem(page)?.label ?? navLabel(page);

  const plannedReconnect = deploymentUpgrade.connection === 'reconnecting';
  const baseHv: HealthView = plannedReconnect
    ? {
        tone: 'muted',
        label: 'Updating…',
        icon: RefreshCw,
        detail: 'Reconnecting after a planned service restart',
        title: 'System update in progress',
        help:
          'The updater is restarting the backend and Console as planned. The durable job ' +
          'continues outside this browser and reconnects automatically.',
      }
    : healthView(health, err);
  // Round-2 Wave 5 tie-in (promised in W1): while demo mode is active the app's own
  // state runs in a throwaway in-memory store, so a "Store degraded"/unreachable
  // warning is expected and irrelevant — MUTE it to a calm demo note rather than
  // alarming the operator. The backend-unreachable critical state still shows.
  const hv: HealthView =
    demoActive && baseHv.tone !== 'critical'
      ? {
          tone: 'muted',
          label: 'Demo mode',
          icon: Database,
          detail: 'Synthetic data (in-memory)',
          title: 'Demo mode — health checks muted',
          help:
            "Demo mode is active, so the platform's own state runs in a throwaway " +
            'in-memory store. Store warnings are expected and muted here. Exit demo ' +
            'mode to see the real store health.',
        }
      : baseHv;
  const HealthIcon = hv.icon;

  // Cmd/Ctrl-K opens the palette; Cmd/Ctrl-B toggles the sidebar width. The palette
  // has no Radix DialogTrigger of its own, so retain the actual external opener and
  // explicitly restore it when Escape, selection, or the close button dismisses it.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        if (paletteOpen) handlePaletteOpenChange(false);
        else openPalette();
      } else if (k === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePaletteOpenChange, openPalette, paletteOpen, toggleCollapsed]);

  // The hamburger toggle, shared by the expanded-header + collapsed-rail slots.
  const navToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-keyshortcuts="Control+B Meta+B"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? 'right' : 'bottom'}>
        {collapsed ? 'Expand navigation' : 'Collapse navigation'}
        <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">⌘B</kbd>
      </TooltipContent>
    </Tooltip>
  );

  return (
    // AnnouncerProvider mounts the ONE app-level aria-live region (§6.3 / E3) and
    // shares announce() so deep components (DataTable sort/bulk outcomes, etc.) can
    // speak status to assistive tech without a visible UI change.
    <AnnouncerProvider>
      <JobMonitor actor={username} onNavigate={onNavigate} />
      <div className="flex min-h-dvh overflow-x-hidden bg-canvas text-foreground">
        {/* Skip-to-main link (#1 — WCAG 2.4.1). Visually hidden until it receives
          keyboard focus, then it pins to the top-left so a keyboard/SR user can jump
          straight past the nav to the routed content (#socMain). */}
      <a
        href="#socMain"
        className={cn(
          'sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-elev2',
          'focus:not-sr-only focus:fixed focus:left-3 focus:top-3',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        )}
      >
        Skip to main content
      </a>

      {/* Mobile navigation is an off-canvas dialog, not a squeezed desktop rail.
          Only one NavSidebar instance is mounted at a time, so disclosure ids and
          aria-current markers stay unique. */}
      {isMobile ? (
        <Sheet open={mobileNavOpen} onOpenChange={handleMobileNavOpenChange}>
          <SheetContent
            ref={mobileNavRef}
            side="left"
            size="sm"
            className="w-[min(18rem,88vw)] max-w-none gap-0 overflow-hidden p-0"
            onOpenAutoFocus={(event) => {
              // Radix otherwise focuses the first destination (Overview), which can
              // make it look active even when the semantic current page is elsewhere.
              // Start keyboard users on the one canonical current-route marker.
              const current =
                mobileNavRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ??
                mobileNavRef.current?.querySelector<HTMLElement>('[data-active-trail="true"]');
              if (!current) return;
              event.preventDefault();
              current.focus();
            }}
          >
            <SheetTitle className="sr-only">Primary navigation</SheetTitle>
            <SheetDescription className="sr-only">
              Navigate between security operations pages.
            </SheetDescription>
            <NavSidebar
              page={page}
              onNavigate={navigateFromMobile}
              collapsed={false}
              openGroups={mobileOpenGroups}
              onToggleGroup={toggleGroup}
              onOpenGroup={openGroup}
              logoUrl={logoUrl}
              productName={productName}
              className="h-full w-full border-r-0"
              reducedMotion={reducedMotion}
              // Reserve the top-right Sheet close button's footprint so a long,
              // operator-provided product name never runs underneath it.
              toggleSlot={<span className="size-8 shrink-0" aria-hidden />}
            />
          </SheetContent>
        </Sheet>
      ) : null}

      {/* ---- Single dockable navigation sidebar (icon rail ↔ labelled drawer) ----
          The wrapper reserves exactly the persisted footprint: 64px while locked
          collapsed, 240px while pinned open. A collapsed grouped destination reveals
          only its compact flyout; hovering never swaps the rail DOM or widens the
          sidebar over routed content. */}
      {!isMobile ? (
        <div
          data-testid="desktop-navigation-frame"
          data-motion={reducedMotion ? 'reduced' : 'full'}
          className={cn(
            // Springy ease (the app's `--motion-ease-premium` curve) gives the rail a
            // physical "settle" without pulling the motion.dev runtime onto the eager
            // first-paint graph (NavSidebar/AppShell are eager; motion stays lazy, §budget).
            'relative shrink-0 min-w-0',
            reducedMotion
              ? 'transition-none'
              : 'transition-[width] duration-200 ease-premium',
            collapsed ? 'z-40 w-16' : 'w-60',
          )}
        >
          <NavSidebar
            page={page}
            onNavigate={navigateFromDesktop}
            collapsed={collapsed}
            openGroups={openGroups}
            onToggleGroup={toggleGroup}
            onOpenGroup={openGroup}
            logoUrl={logoUrl}
            productName={productName}
            toggleSlot={navToggle}
            reducedMotion={reducedMotion}
          />
        </div>
      ) : null}

      {/* ---- Main column --------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar — frosted command-center chrome (GlassSurface honours
            prefers-reduced-transparency by falling back to a solid surface). */}
        <GlassSurface
          as="header"
          blur="md"
          rim={false}
          className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border px-2 sm:gap-3 sm:px-4"
        >
          {isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation"
              aria-expanded={mobileNavOpen}
            >
              <Menu className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}

          {/* Breadcrumb: OUR product name / current page (plain text — untrusted). */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="hidden truncate font-semibold text-foreground sm:inline">{productName}</span>
            <span className="hidden text-muted-foreground sm:inline" aria-hidden>
              /
            </span>
            <span className="truncate text-muted-foreground" aria-current="page">{pageLabel}</span>
          </nav>

          {/* Wide search trigger — an input-styled button that spans the bar and
              opens the command palette (Cmd-K). It grows to fill the space between
              the breadcrumb and the right cluster; on the narrowest widths it is
              hidden and the `md:hidden` icon opener in the right cluster takes over.
              The visible placeholder is decorative — the accessible name comes from
              `aria-label` so it stays distinct from the mobile "Open search" opener. */}
          <button
            type="button"
            onClick={(event) => openPalette(event.currentTarget)}
            aria-label="Search cases, sources, and actions"
            aria-keyshortcuts="Control+K Meta+K"
            className={cn(
              'hidden h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-md border border-input bg-background/60 px-3 text-sm text-muted-foreground transition-colors md:flex lg:max-w-lg',
              'hover:border-border-strong hover:text-foreground',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-left">
              Search cases, sources, actions…
            </span>
            <kbd className="ml-1 hidden shrink-0 rounded border border-border bg-muted px-1 text-[10px] font-medium md:inline-block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/* Compact search opener for the narrowest widths, where the wide trigger
                above is hidden (`md:hidden`). Opens the same command palette. */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 md:hidden"
              onClick={(event) => openPalette(event.currentTarget)}
              aria-label="Open search"
              aria-keyshortcuts="Control+K Meta+K"
            >
              <Search className="h-4 w-4" aria-hidden />
            </Button>

            {!isMobile ? (
              <>
                {/* In-app notification bell (#8) — self-contained: polls the unread
                    count, opens a recent-items dropdown, links to the Inbox page. */}
                <NotificationBell onNavigate={onNavigate} />

                {/* Theme toggle */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={toggleTheme}
                      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                    >
                      {isDark ? (
                        <Sun className="h-4 w-4" aria-hidden />
                      ) : (
                        <Moon className="h-4 w-4" aria-hidden />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
                </Tooltip>
              </>
            ) : null}

            {/* Release identity is build-time first, then reconciled with the public
                backend build-info endpoint. It never infers Stable from SemVer. */}
            <ReleaseBadge buildInfo={buildInfo} />

            {!isMobile && sourceNotice && showSourceNotice ? (
              <UpstreamSourceNoticeButton notice={sourceNotice} />
            ) : null}

            {showSystemUpdateDirect ? (
              <SystemUpdateControl
                upgrade={deploymentUpgrade}
                hasUnsavedChanges={hasUnsavedChanges}
                canRollback={canRollbackSystemUpdates}
              />
            ) : null}

            {deploymentUpdate.target && showDeploymentUpdate ? (
              <DeploymentUpdateButton
                target={deploymentUpdate.target}
                activating={deploymentUpdate.activating}
                hasUnsavedChanges={hasUnsavedChanges}
                onActivate={() => void deploymentUpdate.activate()}
              />
            ) : null}

            {!isMobile ? (
              <>
                {/* Health pill — a click-to-open Popover with plain-language help.
                    store_type/help text is backend-derived and rendered as PLAIN
                    text only (never markup). */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs font-medium',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        TONE_PILL[hv.tone],
                      )}
                      aria-live="polite"
                      aria-label={`Platform health: ${hv.label}`}
                    >
                      <HealthIcon className="h-3.5 w-3.5" aria-hidden />
                      <span className="hidden lg:inline">{hv.label}</span>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-[min(20rem,calc(100vw-2rem))] space-y-1.5 text-xs leading-relaxed"
                  >
                    <p className="flex items-center gap-1.5 font-semibold text-foreground">
                      <HealthIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {hv.title}
                    </p>
                    <p className="whitespace-pre-line text-muted-foreground">{hv.help}</p>
                    <p className="border-t border-border pt-1.5 font-mono text-[11px] text-muted-foreground">
                      {hv.detail}
                    </p>
                  </PopoverContent>
                </Popover>

                {/* User chip + menu (only when auth enabled + authenticated) */}
                {username ? (
                  <>
                    <Separator orientation="vertical" className="hidden h-6 lg:block" />
                    <UserMenu
                      username={username}
                      profile={profile}
                      onNavigate={onNavigate}
                      onLogout={onLogout}
                    />
                  </>
                ) : null}
              </>
            ) : (
              <Sheet open={compactControlsOpen} onOpenChange={setCompactControlsOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SheetTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        aria-label="Open console controls"
                      >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden />
                      </Button>
                    </SheetTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Console controls</TooltipContent>
                </Tooltip>
                <SheetContent
                  side="right"
                  size="sm"
                  data-testid="compact-console-controls"
                  className="gap-0 overflow-y-auto"
                >
                  <SheetHeader>
                    <SheetTitle>Console controls</SheetTitle>
                    <SheetDescription>
                      Notifications, appearance, platform status, and account controls.
                    </SheetDescription>
                  </SheetHeader>

                  <div className="space-y-5 p-5">
                    <section aria-labelledby="compact-preferences-title" className="space-y-2">
                      <h3
                        id="compact-preferences-title"
                        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Preferences
                      </h3>
                      <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">Notifications</p>
                          <p className="text-xs text-muted-foreground">Recent operator activity</p>
                        </div>
                        <NotificationBell
                          onNavigate={navigateFromCompactControls}
                          className="h-11 w-11 shrink-0"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full justify-between px-3 font-normal"
                        onClick={toggleTheme}
                        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                      >
                        <span className="flex items-center gap-2">
                          {isDark ? (
                            <Sun className="h-4 w-4" aria-hidden />
                          ) : (
                            <Moon className="h-4 w-4" aria-hidden />
                          )}
                          Appearance
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {isDark ? 'Dark' : 'Light'}
                        </span>
                      </Button>
                    </section>

                    {(showSourceNotice || showSystemUpdateInCompactControls) && (
                      <section aria-labelledby="compact-maintenance-title" className="space-y-2">
                        <h3
                          id="compact-maintenance-title"
                          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          Maintenance
                        </h3>
                        {sourceNotice && showSourceNotice ? (
                          <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground">Source revision</p>
                              <p className="text-xs text-muted-foreground">Observed upstream only</p>
                            </div>
                            <UpstreamSourceNoticeButton notice={sourceNotice} />
                          </div>
                        ) : null}
                        {showSystemUpdateInCompactControls ? (
                          <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground">System update</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {updatePresentation.label}
                              </p>
                            </div>
                            <SystemUpdateControl
                              upgrade={deploymentUpgrade}
                              hasUnsavedChanges={hasUnsavedChanges}
                              canRollback={canRollbackSystemUpdates}
                            />
                          </div>
                        ) : null}
                      </section>
                    )}

                    <section aria-labelledby="compact-health-title" className="space-y-2">
                      <h3
                        id="compact-health-title"
                        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        Platform
                      </h3>
                      <div
                        className="rounded-md border border-border p-3"
                        role="status"
                        aria-live="polite"
                        aria-label={`Platform health: ${hv.label}`}
                      >
                        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                          <span className={cn('inline-flex rounded-md border p-1.5', TONE_PILL[hv.tone])}>
                            <HealthIcon className="h-4 w-4" aria-hidden />
                          </span>
                          {hv.label}
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{hv.help}</p>
                        <p className="mt-2 border-t border-border pt-2 font-mono text-xs text-muted-foreground">
                          {hv.detail}
                        </p>
                      </div>
                    </section>

                    {username ? (
                      <section aria-labelledby="compact-account-title" className="space-y-2">
                        <h3
                          id="compact-account-title"
                          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          Account
                        </h3>
                        <div className="flex items-center gap-3 rounded-md border border-border p-3">
                          <UserAvatar
                            src={profile?.avatar}
                            name={accountDisplay}
                            className="h-9 w-9 text-xs"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{accountDisplay}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {accountRole ? `${accountRole} · @${username}` : `@${username}`}
                            </p>
                          </div>
                        </div>
                        <div className="grid gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-11 justify-start gap-2 px-3 font-normal"
                            onClick={() => navigateFromCompactControls('account')}
                          >
                            <UserCircle2 className="h-4 w-4" aria-hidden />
                            Profile
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-11 justify-start gap-2 px-3 font-normal"
                            onClick={() => navigateFromCompactControls('security')}
                          >
                            <ShieldCheck className="h-4 w-4" aria-hidden />
                            Security &amp; two-factor
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-11 justify-start gap-2 px-3 font-normal"
                            onClick={() => navigateFromCompactControls('sessions')}
                          >
                            <MonitorSmartphone className="h-4 w-4" aria-hidden />
                            Sessions &amp; activity
                          </Button>
                          {onLogout ? (
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-11 justify-start gap-2 px-3 font-normal text-critical hover:text-critical"
                              onClick={() => {
                                setCompactControlsOpen(false);
                                onLogout();
                              }}
                            >
                              <LogOut className="h-4 w-4" aria-hidden />
                              Log out
                            </Button>
                          ) : null}
                        </div>
                      </section>
                    ) : null}
                  </div>
                </SheetContent>
              </Sheet>
            )}
          </div>
        </GlassSurface>

        {/* Content slot — re-keyed so the fade-in replays on each route change.
            tabIndex={-1} lets the skip-link (#1) move focus here without making it a
            tab stop in the normal order.

            W0-C: the hard `max-w-[1400px]` cap was removed — per-page WIDTH is now
            owned by `<PageContainer variant>` (§4.1). This wrapper is the SINGLE
            gutter/vertical-rhythm authority applied exactly once to every routed page
            (PageContainer no longer re-declares the gutter), so PageContainer and
            not-yet-migrated pages share one consistent inset. Keep `min-w-0` so
            flex/grid children can shrink + truncate. */}
        <main
          id="socMain"
          role="main"
          tabIndex={-1}
          className="min-w-0 flex-1 overflow-x-hidden outline-none"
        >
          {/* Once a real navigation has engaged motion (the lazy chunk was loaded AT the
              time of that navigation — see the `motionActive` latch above), the routed
              content is wrapped in RouteMotion's AnimatePresence for a page → page
              cross-fade; before that it keeps the cheap enter-only CSS fade. The branch
              never flips just because the chunk finished resolving, so neither the landing
              page nor the page shown when the chunk arrives is ever remounted. Both paths
              share CONTENT_INSET so the gutter/vertical rhythm is identical. */}
          {useMotionRoute && RouteMotion ? (
            <RouteMotion routeKey={page} className={CONTENT_INSET}>
              {/* Demo-mode banner — renders only when the demo tenant is active. */}
              <DemoBanner />
              <div className={cn(demoActive && 'mt-4')}>{children}</div>
            </RouteMotion>
          ) : (
            <div key={page} className={cn(CONTENT_INSET, 'animate-fade-in')}>
              {/* Demo-mode banner — renders only when the demo tenant is active. */}
              <DemoBanner />
              <div className={cn(demoActive && 'mt-4')}>{children}</div>
            </div>
          )}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={handlePaletteOpenChange}
        onNavigate={onNavigate}
      />
      </div>
    </AnnouncerProvider>
  );
};
