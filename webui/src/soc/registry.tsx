/**
 * FEATURES[] — the single typed feature registry for the SOC console (Round-5 W0-F F3).
 *
 * Historically the navigation model lived directly in `soc/nav.ts` as a hand-written
 * `NAV_GROUPS` array plus a parallel `HIDDEN_ROUTE_IDS` list, and each of those was
 * consumed by the shell (rail), the command palette, the router, and the breadcrumb.
 * Round-5 lifts that into ONE typed table — {@link FEATURES} — that describes every
 * navigable feature once: its id, label, icon, group, RBAC gate, optional children,
 * whether it is a rail item or a hidden-but-routable deep-link, and — crucially — an
 * {@link FeatureNode.enabled | `enabled(ctx)`} predicate that unifies the three
 * distinct visibility axes (RBAC grant / prefs feature-toggle / demo mode).
 *
 * `nav.ts` is now a THIN derivation layer over this table: it re-exports the SAME
 * shapes it always did (`NAV_GROUPS`, `NAV_ITEMS`, `NAV_CHILDREN`, `PageId`,
 * `PAGE_IDS`, and `navItem`/`navParentOf`/`navLabel`/`isPageId`) so nothing that
 * imports `nav.ts` changes. This is a non-breaking migration behind existing exports;
 * later waves (Rules, Custom-Dash, Coupling) register their features HERE instead of
 * hand-editing the nav array.
 *
 * Design notes:
 *   - The `enabled(ctx)` axes are DELIBERATELY separate: `hasPermission` (RBAC),
 *     `prefsEnabled` (a user/org prefs feature-toggle), and `demoActive` (the demo
 *     tenant). Today's nav only gates on RBAC, so every feature's default `enabled`
 *     checks ONLY its `perm` — behaviour is byte-identical. New features can opt into
 *     the other axes by supplying their own `enabled` without changing the shell.
 *   - Ordering in {@link FEATURES} is authoritative: it preserves the exact group +
 *     item + child order the old `NAV_GROUPS` array had, so the derived rail is
 *     pixel-identical.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { NavOpts } from '@/lib/types';
import {
  LayoutDashboard,
  ShieldAlert,
  MessageSquare,
  BarChart3,
  ScanLine,
  CheckCircle2,
  Library,
  Database,
  ScrollText,
  Settings,
  Bell,
  Gauge,
  CalendarDays,
  Search as SearchIcon,
  DollarSign,
  Cpu,
  BookOpen,
  Brain,
  Workflow,
  Inbox,
  Users as UsersIcon,
  ShieldCheck,
  KeyRound,
  MonitorSmartphone,
  List,
  Network,
  SlidersHorizontal,
  Layers,
  Activity,
  TrendingUp,
  Columns3,
  BookMarked,
  BookOpenText,
} from 'lucide-react';

/* -------------------------------------------------------------------------- */
/* Stable id + group unions (the router validates hashes against PageId).      */
/* -------------------------------------------------------------------------- */

/** Stable page ids — the router validates the hash against these. */
export type PageId =
  | 'overview'
  | 'dashboard'
  | 'dashboards'
  | 'cases'
  | 'case_manager'
  | 'investigate'
  | 'chat'
  | 'intelligence'
  | 'metrics'
  | 'effectiveness'
  | 'models'
  | 'scans'
  | 'standup'
  | 'catalog'
  | 'runbooks'
  | 'playbooks'
  | 'personas'
  | 'approvals'
  | 'knowledge'
  | 'memory'
  | 'sources'
  | 'cost'
  | 'inbox'
  | 'account'
  | 'sessions'
  | 'settings'
  | 'security'
  | 'roles'
  | 'users'
  | 'audit'
  | 'admin_sessions'
  | 'logs'
  | 'campaigns'
  | 'tuning'
  | 'batchjobs'
  | 'baseline'
  | 'docs';

export type NavGroupId =
  | 'overview'
  | 'triage'
  | 'intelligence'
  | 'analytics'
  | 'notifications'
  | 'platform';

/**
 * A permission requirement (`resource:action`) gating a feature. When present, the
 * shell hides the feature from users without the grant. Features without a `perm` are
 * always shown (back-compat: visible when auth/RBAC are off).
 */
export interface NavPerm {
  resource: string;
  action: string;
}

/* -------------------------------------------------------------------------- */
/* enabled(ctx): the three visibility axes, unified.                          */
/* -------------------------------------------------------------------------- */

/**
 * The evaluation context passed to {@link FeatureNode.enabled}. The three fields are
 * the three DISTINCT axes a feature can be gated on; a feature combines them however
 * it needs (default: RBAC only).
 */
export interface FeatureCtx {
  /** RBAC axis: true when auth/RBAC are off, else consults the permission matrix. */
  hasPermission: (resource: string, action: string) => boolean;
  /** Prefs feature-toggle axis: is a named opt-in feature flag enabled? Default true. */
  prefsEnabled?: (flag: string) => boolean;
  /** Demo axis: is the demo tenant currently active? */
  demoActive?: boolean;
}

/**
 * One feature in the registry. A feature is a navigable destination; it may be a
 * top-level rail item, a child (sub-page of a host feature), or a hidden-but-routable
 * deep-link that keeps its own route/PageId but is not shown in the rail.
 */
export interface FeatureNode {
  id: PageId;
  label: string;
  /** Lucide icon component. Children may omit it. */
  icon?: LucideIcon;
  group: NavGroupId;
  /** Optional RBAC gate; consumed by the default {@link FeatureNode.enabled}. */
  perm?: NavPerm;
  /**
   * Optional child destinations (expandable disclosure nav). Children are thin leaves
   * (never nested further) that a host feature tabs between. A child id MUST be a
   * routable PageId registered in App.renderPage.
   */
  children?: FeatureChild[];
  /**
   * True when this feature is routable + deep-linkable but NOT a rail item (a
   * consolidated sub-page kept for cutover safety / deep-links). Hidden features are
   * excluded from the derived NAV_GROUPS/NAV_ITEMS but still contribute to PAGE_IDS.
   */
  hidden?: boolean;
  /**
   * Where a visible destination appears in the shell. `main` (default) participates
   * in the normal grouped, scrollable rail; `footer` is pinned beneath that list for
   * durable help/support destinations. Both remain registry-derived and routable.
   */
  navPlacement?: 'main' | 'footer';
  /**
   * Unified visibility predicate over the three axes. Defaults (via
   * {@link featureEnabled}) to the RBAC axis only, so existing features behave exactly
   * as before. A feature may override to fold in prefs-toggle / demo.
   */
  enabled?: (ctx: FeatureCtx) => boolean;
}

/** A sub-page (child) under a host {@link FeatureNode}. */
export interface FeatureChild {
  id: PageId;
  label: string;
  icon?: LucideIcon;
  perm?: NavPerm;
  enabled?: (ctx: FeatureCtx) => boolean;
}

/**
 * Default visibility evaluation: check the RBAC axis (the item's `perm`, if any), then
 * defer to a feature-supplied `enabled` override. This is the SINGLE place the three
 * axes are combined, so callers never re-implement the RBAC check.
 */
export function featureEnabled(
  node: { perm?: NavPerm; enabled?: (ctx: FeatureCtx) => boolean },
  ctx: FeatureCtx,
): boolean {
  if (node.enabled) return node.enabled(ctx);
  return !node.perm || ctx.hasPermission(node.perm.resource, node.perm.action);
}

/* -------------------------------------------------------------------------- */
/* The registry.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one typed feature table. Order is authoritative (drives rail order). Every
 * top-level rail feature keeps `hidden` falsey; consolidated deep-link-only sub-pages
 * are `hidden: true`. `nav.ts` derives NAV_GROUPS / PAGE_IDS / lookups from this.
 */
export const FEATURES: FeatureNode[] = [
  /* ---- Overview -------------------------------------------------------- */
  {
    id: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    group: 'overview',
    children: [
      { id: 'dashboard', label: 'Dashboard', icon: Gauge },
      // Round-5 G7 (CD5): the build-your-own custom dashboards surface. Ships ON by
      // default (a read-only per-role default layout; Edit mode to customize) and is
      // gated on the SAME `metrics:view` grant the backend routes_dashboards.py
      // require, so it never appears for a principal who can't read the metrics it
      // renders. RBAC off → always visible (back-compat).
      {
        id: 'dashboards',
        label: 'Dashboards',
        icon: LayoutDashboard,
        perm: { resource: 'metrics', action: 'view' },
      },
      { id: 'standup', label: 'Standup', icon: CalendarDays },
    ],
  },

  /* ---- Triage ---------------------------------------------------------- */
  { id: 'cases', label: 'Cases', icon: ShieldAlert, group: 'triage' },
  {
    id: 'case_manager',
    label: 'Case Manager',
    icon: Columns3,
    group: 'triage',
    perm: { resource: 'cases', action: 'read' },
  },
  {
    id: 'campaigns',
    label: 'Campaigns',
    icon: Network,
    group: 'triage',
    perm: { resource: 'cases', action: 'read' },
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: List,
    group: 'triage',
    perm: { resource: 'sources', action: 'read' },
  },
  {
    id: 'chat',
    label: 'Workspace',
    icon: MessageSquare,
    group: 'triage',
    children: [
      { id: 'chat', label: 'Chat', icon: MessageSquare },
      { id: 'investigate', label: 'Entity investigation', icon: SearchIcon },
    ],
  },
  {
    // The old Automated Scans dashboard repeated the same autonomous-case state
    // already exposed more completely by Case Manager. Keep the id + lazy route for
    // bookmarked links, but remove it from the primary information architecture.
    id: 'scans',
    label: 'Automated scans (legacy)',
    icon: ScanLine,
    group: 'triage',
    hidden: true,
  },
  {
    id: 'approvals',
    label: 'Approvals',
    icon: CheckCircle2,
    group: 'triage',
    perm: { resource: 'proposals', action: 'read' },
  },

  /* ---- Intelligence ---------------------------------------------------- */
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: Library,
    group: 'intelligence',
    children: [
      {
        id: 'knowledge',
        label: 'Knowledge corpus',
        icon: BookOpen,
        perm: { resource: 'rag', action: 'read' },
      },
      {
        id: 'runbooks',
        label: 'Reference runbooks',
        icon: BookMarked,
        perm: { resource: 'runbooks', action: 'read' },
      },
      {
        id: 'memory',
        label: 'Operator memory',
        icon: Brain,
        perm: { resource: 'memory', action: 'read' },
      },
      {
        id: 'playbooks',
        label: 'Response playbooks',
        icon: Workflow,
        perm: { resource: 'playbooks', action: 'read' },
      },
      {
        // GET /api/personas is an authenticated read-only catalog and has no
        // resource-specific RBAC gate. Keep the Console aligned with that contract
        // instead of hiding the reference roster behind playbooks:read.
        id: 'personas',
        label: 'Agent personas',
        icon: UsersIcon,
      },
    ],
  },

  /* ---- Analytics ------------------------------------------------------- */
  {
    id: 'metrics',
    label: 'Analytics',
    icon: BarChart3,
    group: 'analytics',
    children: [
      // The Metrics page loads GET /api/metrics, which routes_metrics.py gates on
      // `metrics:view` — so the nav child gates on the SAME grant (mirroring the
      // `dashboards` sibling), never showing an entry that would 403 on open. (`cost`
      // and `models` stay ungated: their GET endpoints — /api/usage/summary,
      // /api/llm/models — are auth-only, no per-resource grant, so gating them would
      // hide a page the principal can actually read.)
      { id: 'metrics', label: 'Metrics', icon: BarChart3, perm: { resource: 'metrics', action: 'view' } },
      {
        id: 'effectiveness',
        label: 'Agent effectiveness',
        icon: TrendingUp,
        perm: { resource: 'metrics', action: 'view' },
      },
      { id: 'cost', label: 'Cost', icon: DollarSign },
      { id: 'models', label: 'Models', icon: Cpu },
      {
        id: 'baseline',
        label: 'Baseline',
        icon: Activity,
        perm: { resource: 'settings', action: 'read' },
      },
      {
        id: 'batchjobs',
        label: 'Jobs',
        icon: Layers,
      },
    ],
  },

  /* ---- Notifications --------------------------------------------------- */
  {
    id: 'inbox',
    label: 'Notifications',
    icon: Bell,
    group: 'notifications',
    children: [{ id: 'inbox', label: 'Inbox', icon: Inbox }],
  },

  /* ---- Platform -------------------------------------------------------- */
  { id: 'sources', label: 'Sources', icon: Database, group: 'platform' },
  {
    id: 'audit',
    label: 'Audit log',
    icon: ScrollText,
    group: 'platform',
    perm: { resource: 'audit', action: 'view' },
  },
  {
    id: 'tuning',
    label: 'Auto-tuning',
    icon: SlidersHorizontal,
    group: 'platform',
    perm: { resource: 'automation', action: 'read' },
  },
  {
    // Round-5 Sett-B: the Settings rail item surfaces the two promoted, admin-only
    // "Security & access" destinations (Users, Roles) as disclosure children. They keep
    // their own PageIds (deep-link back-compat) but the router (SETTINGS_REDIRECTS)
    // rewrites each `#/<id>` to `#/settings?s=<id>` so clicking a child lands INSIDE
    // Settings — no separate standalone home. Each child gates on the SAME resolvable
    // grant its Settings section + page require — bug #7 fix: the former `roles:view` /
    // `users:view` gates were non-existent actions (`roles` = read|manage, `users` =
    // manage) that hid the item from operators who actually held `manage`. Unified on
    // `manage`. (SSO / Sessions / Active-sessions / Secret-keys stay reachable via the
    // Settings rail itself; surfacing only the two highest-value admin tables keeps the
    // sidebar to ≤2 nesting levels and avoids the `security` PageId ↔ section collision:
    // the `security` PageId redirects to PERSONAL 2FA, while the org SSO Settings
    // section is `?s=security`.)
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    group: 'platform',
    children: [
      { id: 'users', label: 'Users', icon: UsersIcon, perm: { resource: 'users', action: 'manage' } },
      { id: 'roles', label: 'Roles', icon: KeyRound, perm: { resource: 'roles', action: 'manage' } },
    ],
  },
  {
    id: 'docs',
    label: 'Documentation',
    icon: BookOpenText,
    group: 'platform',
    navPlacement: 'footer',
  },

  /* ---- Hidden-but-routable consolidated sub-pages ---------------------- *
   * Round-2 W4 / Round-3 disclosure: these keep their PageId + App.renderPage
   * arm (deep-linkable) but are NOT rail items. Some duplicate a rail id (e.g.
   * they also appear as a child above); the derivation de-dupes PAGE_IDS. The
   * `group` here is only a bookkeeping home — hidden features never enter a rail
   * group. Order mirrors the old HIDDEN_ROUTE_IDS list for stability.            */
  { id: 'dashboard', label: 'Dashboard', icon: Gauge, group: 'overview', hidden: true },
  { id: 'investigate', label: 'Entity investigation', icon: SearchIcon, group: 'triage', hidden: true },
  { id: 'cost', label: 'Cost', icon: DollarSign, group: 'analytics', hidden: true },
  { id: 'models', label: 'Models', icon: Cpu, group: 'analytics', hidden: true },
  { id: 'standup', label: 'Standup', icon: CalendarDays, group: 'overview', hidden: true },
  {
    id: 'knowledge',
    label: 'Knowledge corpus',
    icon: BookOpen,
    group: 'intelligence',
    hidden: true,
    perm: { resource: 'rag', action: 'read' },
  },
  {
    id: 'runbooks',
    label: 'Reference runbooks',
    icon: BookMarked,
    group: 'intelligence',
    hidden: true,
    perm: { resource: 'runbooks', action: 'read' },
  },
  {
    id: 'memory',
    label: 'Operator memory',
    icon: Brain,
    group: 'intelligence',
    hidden: true,
    perm: { resource: 'memory', action: 'read' },
  },
  {
    id: 'catalog',
    label: 'Response playbooks',
    icon: Library,
    group: 'intelligence',
    hidden: true,
    perm: { resource: 'playbooks', action: 'read' },
  },
  {
    id: 'playbooks',
    label: 'Response playbooks',
    icon: Workflow,
    group: 'intelligence',
    hidden: true,
    perm: { resource: 'playbooks', action: 'read' },
  },
  {
    id: 'personas',
    label: 'Agent personas',
    icon: UsersIcon,
    group: 'intelligence',
    hidden: true,
  },
  // Round-5 Sett-B: the six formerly-standalone admin/account homes
  // (account/sessions/security/roles/users/admin_sessions) collapsed INTO Settings
  // sections. Their PageIds stay registered (deep-link back-compat) but the router
  // (SETTINGS_REDIRECTS) rewrites `#/<id>` → `#/settings?s=<sectionId>` — the standalone
  // App.renderPage arms are no longer the primary home. Keeping them here keeps
  // `isPageId('roles')` true so the redirect fires instead of a 404-to-Overview.
  { id: 'account', label: 'Account', icon: Settings, group: 'platform', hidden: true },
  { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone, group: 'platform', hidden: true },
  { id: 'security', label: 'Security', icon: ShieldCheck, group: 'platform', hidden: true },
  { id: 'roles', label: 'Roles', icon: KeyRound, group: 'platform', hidden: true },
  { id: 'users', label: 'Users', icon: UsersIcon, group: 'platform', hidden: true },
  { id: 'admin_sessions', label: 'Admin sessions', icon: MonitorSmartphone, group: 'platform', hidden: true },
];

/**
 * Group ids + display labels, in rail order. Kept beside {@link FEATURES} so the
 * derivation in `nav.ts` can build NAV_GROUPS without a second source of ordering.
 */
export const FEATURE_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'triage', label: 'Triage' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'platform', label: 'Platform' },
];

/* -------------------------------------------------------------------------- */
/* The route table — the SINGLE lazy page registry (Round-5 Coupling-A).       */
/* -------------------------------------------------------------------------- */

/**
 * EVERY page component is `React.lazy()`, so the first-paint (entry) chunk ships ONLY
 * the shell + this thin table of import thunks — never a page body. A route renders its
 * chunk only when navigated to; `App.tsx`'s single `<Suspense>` covers the fetch, and
 * its `<ErrorBoundary>` catches a failed chunk load instead of white-screening. All
 * targets are DEFAULT exports (verified) so the bare `import()` resolves to the
 * `{ default }` module `React.lazy` expects; the two component-directory pages
 * (`UnifiedLogsSheet`, and — historically — others) are named-export-adapted below.
 *
 * NOTE: Login + the first-run Wizard are intentionally NOT here — they own first paint
 * (the login gate + OOBE) and stay EAGERLY imported in `App.tsx`, framer-motion-free.
 */
const Home = React.lazy(() => import('./pages/Home'));
const Dashboards = React.lazy(() => import('./pages/Dashboards'));
const Cases = React.lazy(() => import('./pages/Cases'));
const CaseManager = React.lazy(() => import('./pages/CaseManager'));
const Workspace = React.lazy(() => import('./pages/Workspace'));
const Scans = React.lazy(() => import('./pages/Scans'));
const Analytics = React.lazy(() => import('./pages/Analytics'));
const Intelligence = React.lazy(() => import('./pages/Intelligence'));
const Sources = React.lazy(() => import('./pages/Sources'));
// NB: the host-tab leaves (Chat/Investigate → Workspace, Standup → Home, Cost →
// Analytics, Knowledge/Runbooks/Memory/Playbooks/Personas → Intelligence) no longer
// have their OWN lazy
// const here — each routes THROUGH its host with a forced `tab` (see ROUTES below), so
// their page module is loaded by the host's chunk, not a second standalone chunk.
// NB: several page names collide with the lucide icon imports at the top of this file
// (Settings, Inbox, Users, …) — the lazy page consts are `*Page`-suffixed to avoid it.
const SettingsPage = React.lazy(() => import('./pages/Settings'));
const SecurityPage = React.lazy(() => import('./pages/Security'));
const Approvals = React.lazy(() => import('./pages/Approvals'));
const UsersPage = React.lazy(() => import('./pages/Users'));
const Audit = React.lazy(() => import('./pages/Audit'));
const Account = React.lazy(() => import('./pages/Account'));
const SessionsPage = React.lazy(() => import('./pages/Sessions'));
const AdminSessions = React.lazy(() => import('./pages/AdminSessions'));
const Models = React.lazy(() => import('./pages/Models'));
const Roles = React.lazy(() => import('./pages/Roles'));
const InboxPage = React.lazy(() => import('./pages/Inbox'));
// The `logs` route renders the STANDALONE full-page view — the module's DEFAULT export
// (`UnifiedLogsView`), not the `UnifiedLogsSheet` sheet variant (which needs open/onClose).
const UnifiedLogs = React.lazy(() => import('./components/UnifiedLogsSheet'));
const Campaigns = React.lazy(() => import('./pages/Campaigns'));
const Tuning = React.lazy(() => import('./pages/Tuning'));
const BatchJobs = React.lazy(() => import('./pages/BatchJobs'));
const BaselineStats = React.lazy(() => import('./pages/Baseline'));
const Docs = React.lazy(() => import('./pages/Docs'));

/** The context a route render thunk may read (never `onNavigate` — pages use `useNavigate`). */
export interface RouteRenderCtx {
  /** In-memory navigation opts for the active page (tab / status / caseId …). */
  opts?: NavOpts;
  /** Re-launch the first-run wizard (Settings only). */
  onRerunWizard: () => void;
}

/**
 * One route: a lazy page element and an optional `render` that supplies page-CONFIG
 * props (tab / initialStatus / onRerunWizard) from the route ctx. `render` NEVER passes
 * `onNavigate` — pages resolve navigation via `useNavigate()`/`useNavigateOptional()`
 * from the router context (Coupling-A: no navigate prop-drilling). When `render` is
 * absent the page takes no route-derived props and App renders the bare element.
 */
export interface RouteDef {
  element: React.LazyExoticComponent<React.ComponentType<any>>;
  render?: (ctx: RouteRenderCtx) => React.ReactElement;
}

/**
 * The route table, keyed by {@link PageId}. Derived id-for-id from `FEATURES` (every
 * registered/hidden id resolves here); this is the ONE place a page id maps to its lazy
 * component + its config-prop wiring, replacing the old hand-maintained `App.renderPage`
 * switch AND the parallel eager lazy-declaration table.
 *
 * Host pages (`overview`/`chat`/`metrics`/`intelligence`) read their active sub-`tab`
 * from the route ctx; the two deep-link leaves that force a specific sub-view
 * (`dashboard` → Dashboard tab, `playbooks`/`personas` → their Intelligence surface)
 * pass a fixed `tab`. `cases`
 * seeds its status filter from `opts.status` and its severity facet from `opts.severity`
 * (#38 drill-through); `settings` receives `onRerunWizard`. No route passes `onNavigate`
 * — pages use `useNavigate()`/`useNavigateOptional()`.
 */
export const ROUTES: Record<PageId, RouteDef> = {
  /* ---- Round-2 W4 consolidated HOST pages (tabbed) ---- */
  overview: { element: Home, render: (c) => <Home tab={c.opts?.tab} /> },
  chat: {
    element: Workspace,
    render: (c) => <Workspace tab={c.opts?.tab} caseId={c.opts?.caseId} />,
  },
  metrics: { element: Analytics, render: (c) => <Analytics tab={c.opts?.tab} /> },
  intelligence: { element: Intelligence, render: (c) => <Intelligence tab={c.opts?.tab} /> },

  /* ---- Deep-link leaves that force a host sub-tab ----
   * ROUTING RULE (Round-6 consistency fix): a disclosure child that its host embeds as
   * a TAB routes THROUGH that host with a forced `tab`, so the child renders inside the
   * host's segmented strip — never as a bare, strip-less DUPLICATE of the same content
   * at a second URL, and never losing lateral access to its sibling tabs. This is how
   * `dashboard`/`playbooks` already resolved; it now covers EVERY host-tab child:
   *   Overview     → dashboard | standup
   *   Workspace    → chat | investigate
   *   Analytics    → metrics | effectiveness | cost
   *   Intelligence → knowledge | runbooks | memory | playbooks | personas
   * Children that are GENUINELY standalone pages (they are NOT a tab of any host —
   * `dashboards` [custom-dashboard builder], `models`, `baseline`, `batchjobs`, `inbox`)
   * keep a standalone route below. */
  dashboard: { element: Home, render: () => <Home tab="dashboard" /> },
  dashboards: { element: Dashboards },
  playbooks: { element: Intelligence, render: () => <Intelligence tab="playbooks" /> },
  personas: { element: Intelligence, render: () => <Intelligence tab="personas" /> },

  /* ---- Standalone admin / notification surfaces ---- */
  models: { element: Models },
  roles: { element: Roles },
  inbox: { element: InboxPage },

  /* ---- Triage ---- */
  cases: {
    element: Cases,
    render: (c) => (
      <Cases
        initialStatus={c.opts?.status}
        initialAssignee={c.opts?.assignee}
        initialTag={c.opts?.tag}
        initialSeverity={c.opts?.severity}
        initialNoiseOutcome={c.opts?.noiseOutcome}
        initialWindowHours={c.opts?.window}
      />
    ),
  },
  case_manager: {
    element: CaseManager,
    render: (c) => <CaseManager initialCaseId={c.opts?.caseId} />,
  },
  scans: { element: Scans },
  approvals: { element: Approvals },
  sources: { element: Sources },

  /* ---- Round-4 surfaces ---- */
  logs: { element: UnifiedLogs },
  campaigns: { element: Campaigns },
  tuning: { element: Tuning },
  batchjobs: { element: BatchJobs },
  baseline: { element: BaselineStats },
  docs: { element: Docs },

  /* ---- Host-tab leaves: route THROUGH the host with a forced tab (see rule above) --- */
  investigate: { element: Workspace, render: () => <Workspace tab="investigate" /> },
  standup: { element: Home, render: () => <Home tab="standup" /> },
  effectiveness: { element: Analytics, render: () => <Analytics tab="effectiveness" /> },
  cost: { element: Analytics, render: () => <Analytics tab="cost" /> },
  knowledge: { element: Intelligence, render: () => <Intelligence tab="knowledge" /> },
  runbooks: { element: Intelligence, render: () => <Intelligence tab="runbooks" /> },
  memory: { element: Intelligence, render: () => <Intelligence tab="memory" /> },
  // `catalog` is a compatibility alias for the old combined destination.
  catalog: { element: Intelligence, render: () => <Intelligence tab="playbooks" /> },

  /* ---- Settings-redirected ids: INTENTIONALLY-unreachable-but-registered ----
   * `account`/`sessions`/`admin_sessions`/`security`/`users`/`roles` always redirect to
   * a Settings section (SETTINGS_REDIRECTS in router.tsx), so `pageFromHash` never
   * returns these ids and renderRoute never renders these entries at runtime. They are
   * kept ON PURPOSE, not dead: (a) `ROUTES` is an EXHAUSTIVE `Record<PageId, RouteDef>`
   * (a compile-time guarantee every PageId has a route), (b) `route-registry.test.tsx`
   * pins that every PageId resolves, and (c) they are a defensive fallback — if a
   * redirect entry were ever dropped, the id would render its real page instead of a
   * white-screen. The lazy consts are shared with the Settings section files that import
   * these pages directly, so no extra "never-fetched" chunk actually ships. */
  account: { element: Account },
  sessions: { element: SessionsPage },
  admin_sessions: { element: AdminSessions },
  settings: {
    element: SettingsPage,
    render: (c) => <SettingsPage onRerunWizard={c.onRerunWizard} />,
  },
  security: { element: SecurityPage },
  users: { element: UsersPage },
  audit: { element: Audit },
};

/**
 * Resolve a page id to a rendered element. Unknown ids fall back to Overview (mirrors the
 * router's `pageFromHash` default), so a stale hash never white-screens.
 */
export function renderRoute(page: PageId, ctx: RouteRenderCtx): React.ReactElement {
  const def = ROUTES[page] ?? ROUTES.overview;
  const El = def.element;
  return def.render ? def.render(ctx) : <El />;
}
