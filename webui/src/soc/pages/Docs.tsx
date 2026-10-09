/**
 * Version-aware, same-origin Help Center.
 *
 * Product guidance is bundled with the Console release and served below
 * `/docs/{major.minor}/`. This page is deliberately a compact discovery hub rather
 * than a second Markdown renderer: MkDocs owns article navigation and rendering,
 * while the Console owns release context, category discovery, and local filtering.
 */
import * as React from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  CircleHelp,
  Compass,
  LifeBuoy,
  Search,
  Settings2,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import {
  CONSOLE_RELEASE_IDENTITY,
  resolveReleasePresentation,
  type ReleaseIdentity,
  type RuntimeBuildInfo,
} from '@/lib/release';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

export const PUBLIC_STABLE_DOCS_URL =
  'https://arydestroyer.github.io/Agentic-Kibana/stable/';
export const DEVELOPMENT_DOCS_URL =
  'https://github.com/ARYDESTROYER/Agentic-Kibana/tree/Testing/docs';

/** Source tree matching the immutable Console bundle, never a guessed branch. */
export function documentationSourceUrl(identity: ReleaseIdentity): string {
  const sourceRef = identity.channel === 'stable' ? `v${identity.version}` : 'Testing';
  return `https://github.com/ARYDESTROYER/Agentic-Kibana/tree/${sourceRef}/docs`;
}

export type DocsCategoryId = 'use' | 'admin' | 'operate' | 'reference';

interface DocsArticle {
  title: string;
  description: string;
  path: string;
  keywords: readonly string[];
}

interface DocsCategory {
  id: DocsCategoryId;
  title: string;
  shortTitle: string;
  description: string;
  icon: LucideIcon;
  articles: readonly DocsArticle[];
}

export const DOC_CATEGORIES: readonly DocsCategory[] = [
  {
    id: 'use',
    title: 'Use the product',
    shortTitle: 'Use',
    description: 'Day-to-day guidance for analysts working alerts, cases, and investigations.',
    icon: Compass,
    articles: [
      {
        title: 'Get started',
        description: 'Orient yourself in the Console and complete the first-run workflow.',
        path: 'getting-started/',
        keywords: ['quickstart', 'first run', 'setup', 'tour'],
      },
      {
        title: 'Dashboard',
        description: 'Read posture, risk, case lifecycle, and noise-reduction signals.',
        path: 'analyst/overview/',
        keywords: ['command center', 'home', 'metrics', 'noise'],
      },
      {
        title: 'Cases',
        description: 'Find, filter, assign, and resolve cases in the analyst queue.',
        path: 'analyst/cases/',
        keywords: ['queue', 'status', 'assignee', 'bulk'],
      },
      {
        title: 'Case Manager',
        description: 'Work the split queue, inspect evidence, and take audited action.',
        path: 'analyst/case-manager/',
        keywords: ['triage', 'decision', 'risk', 'timeline'],
      },
      {
        title: 'Investigation',
        description: 'Understand the agent assessment, evidence trace, and deterministic decision.',
        path: 'analyst/investigation/',
        keywords: ['entity', 'ioc', 'confidence', 'verdict', 'chat'],
      },
      {
        title: 'Workspace Chat',
        description: 'Ask read-only questions, follow each lookup, track tokens and cost, and build reports from answers.',
        path: 'analyst/chat/',
        keywords: [
          'chat',
          'workspace',
          'conversation',
          'history',
          'source',
          'model',
          'evidence',
          'report',
          'reports',
          'tokens',
          'cost',
          'export',
        ],
      },
      {
        title: 'Logs and search',
        description: 'Search connected telemetry and move safely from evidence to a case.',
        path: 'analyst/logs-search/',
        keywords: ['events', 'telemetry', 'query', 'sources'],
      },
      {
        title: 'Collaboration',
        description: 'Coordinate notes, tasks, handoffs, and case activity with the SOC team.',
        path: 'analyst/collaboration/',
        keywords: ['thread', 'handoff', 'task', 'mention'],
      },
      {
        title: 'Campaigns',
        description: 'Review advisory cross-case groupings without merging case identity or decisions.',
        path: 'analyst/campaigns/',
        keywords: ['campaign', 'related cases', 'entities', 'mitre', 'incident'],
      },
      {
        title: 'Analytics and standup',
        description: 'Interpret posture, effectiveness, timing, noise reduction, cost, and shift handoff.',
        path: 'analyst/analytics/',
        keywords: ['analytics', 'metrics', 'effectiveness', 'standup', 'mtta', 'mttr', 'cost'],
      },
      {
        title: 'Playbooks and approvals',
        description: 'Browse procedures, edit operator playbooks, and understand approval gates.',
        path: 'automation/playbooks-approvals/',
        keywords: ['procedure', 'runbook', 'automation', 'review'],
      },
    ],
  },
  {
    id: 'admin',
    title: 'Administer',
    shortTitle: 'Admin',
    description: 'Configure the organization, access, sources, automation, and model controls.',
    icon: ShieldCheck,
    articles: [
      {
        title: 'Settings',
        description: 'Navigate the settings workspace and understand configuration ownership.',
        path: 'administration/settings/',
        keywords: ['preferences', 'configuration', 'organization'],
      },
      {
        title: 'Users and roles',
        description: 'Manage operators, built-in roles, custom permissions, and access boundaries.',
        path: 'administration/users-rbac/',
        keywords: ['rbac', 'permissions', 'accounts', 'teams'],
      },
      {
        title: 'Authentication',
        description: 'Configure sessions, MFA, SSO, and account security.',
        path: 'administration/authentication/',
        keywords: ['login', 'mfa', 'oidc', 'session', 'sso'],
      },
      {
        title: 'Sources and feeds',
        description: 'Connect supported telemetry sources and validate their ingest health.',
        path: 'sources/',
        keywords: ['elastic', 'opensearch', 'wazuh', 'connector', 'ingest'],
      },
      {
        title: 'Models and spend',
        description: 'Choose model providers, control budgets, and interpret usage costs.',
        path: 'administration/models-spend/',
        keywords: ['llm', 'cost', 'budget', 'provider'],
      },
      {
        title: 'Rules and automation',
        description: 'Operate detection rules, previews, tuning, baselines, and approvals.',
        path: 'automation/',
        keywords: ['rules', 'autopilot', 'threshold', 'baseline', 'tuning'],
      },
      {
        title: 'Notifications',
        description: 'Configure in-app and external delivery channels without exposing secrets.',
        path: 'administration/notifications/',
        keywords: ['email', 'slack', 'teams', 'pagerduty', 'alerts'],
      },
    ],
  },
  {
    id: 'operate',
    title: 'Deploy & operate',
    shortTitle: 'Operate',
    description: 'Install, upgrade, monitor, protect, and recover a supported deployment.',
    icon: Settings2,
    articles: [
      {
        title: 'Install and deploy',
        description: 'Choose a deployment shape and bring up the supported standalone Console.',
        path: 'operations/deployment/',
        keywords: ['docker', 'compose', 'install', 'postgres', 'elasticsearch'],
      },
      {
        title: 'Configuration',
        description: 'Map environment variables and runtime settings to deployment behavior.',
        path: 'operations/configuration/',
        keywords: ['environment', 'env', 'secrets', 'state backend'],
      },
      {
        title: 'Health, backup, and recovery',
        description: 'Check service health and protect or restore application state.',
        path: 'operations/health-backup/',
        keywords: ['status', 'backup', 'restore', 'disaster recovery'],
      },
      {
        title: 'Upgrades',
        description: 'Promote releases safely while preserving state and compatibility.',
        path: 'operations/upgrades/',
        keywords: ['migration', 'release', 'version', 'rollback'],
      },
      {
        title: 'Security operations',
        description: 'Harden the deployment and preserve Agentic SOC security boundaries.',
        path: 'operations/security/',
        keywords: ['hardening', 'tls', 'credentials', 'audit'],
      },
      {
        title: 'Troubleshooting',
        description: 'Diagnose common startup, connectivity, ingest, and Console failures.',
        path: 'operations/troubleshooting/',
        keywords: ['error', 'failure', 'debug', 'support'],
      },
    ],
  },
  {
    id: 'reference',
    title: 'Reference & releases',
    shortTitle: 'Reference',
    description: 'Look up contracts, terminology, compatibility, and version-specific changes.',
    icon: LifeBuoy,
    articles: [
      {
        title: 'Product glossary',
        description: 'Use the canonical meaning of case, verdict, status, risk, and disposition.',
        path: 'concepts/terminology/',
        keywords: ['terms', 'nomenclature', 'definitions'],
      },
      {
        title: 'Deterministic decisions',
        description: 'Understand the policy boundary between model verdicts and case actions.',
        path: 'concepts/deterministic-decisions/',
        keywords: ['auto-close', 'policy', 'verdict', 'authority'],
      },
      {
        title: 'API reference',
        description: 'Review supported API resources, request contracts, and authentication.',
        path: 'reference/api/',
        keywords: ['endpoint', 'openapi', 'integration'],
      },
      {
        title: 'Permissions reference',
        description: 'Look up the resource and action permissions used by each role.',
        path: 'reference/permissions/',
        keywords: ['rbac', 'role', 'authorization'],
      },
      {
        title: 'Compatibility',
        description: 'Check supported platforms, source versions, and integration constraints.',
        path: 'reference/compatibility/',
        keywords: ['support matrix', 'elastic', 'browser'],
      },
      {
        title: 'Release notes',
        description: 'See what changed in this documentation and application release line.',
        path: 'releases/0.1/',
        keywords: ['changelog', 'what is new', 'known issues'],
      },
      {
        title: 'Documentation versions',
        description: 'Learn how installed, Stable, and development documentation relate.',
        path: 'releases/documentation-versions/',
        keywords: ['versioning', 'stable', 'testing', 'latest'],
      },
    ],
  },
] as const;

/** A patch release shares the matching major.minor documentation line. */
export function docsVersionLine(version: string): string {
  const match = version.trim().match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : 'development';
}

/** Same-origin immutable article URL for the documentation bundled with this app. */
export function docsArticleUrl(path: string, version: string): string {
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  return `/docs/${docsVersionLine(version)}/${cleanPath}/`;
}

function includesQuery(article: DocsArticle, query: string): boolean {
  if (!query) return true;
  const haystack = [article.title, article.description, ...article.keywords]
    .join(' ')
    .toLocaleLowerCase();
  return haystack.includes(query);
}

export interface DocsProps {
  /** Injectable only for deterministic release-context tests. */
  releaseIdentity?: ReleaseIdentity;
  /**
   * Optional runtime identity override. `undefined` fetches the backend stamp;
   * `null` intentionally represents an unavailable stamp in isolated tests.
   */
  backendInfo?: RuntimeBuildInfo | null;
}

export default function Docs({
  releaseIdentity = CONSOLE_RELEASE_IDENTITY,
  backendInfo,
}: DocsProps): React.ReactElement {
  const [fetchedBackendInfo, setFetchedBackendInfo] = React.useState<RuntimeBuildInfo | null>(null);

  React.useEffect(() => {
    if (backendInfo !== undefined) return undefined;
    if (typeof api.buildInfo !== 'function') return undefined;
    let alive = true;
    void api
      .buildInfo()
      .then((value) => {
        if (alive) setFetchedBackendInfo(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backendInfo]);

  const runtimeBackendInfo = backendInfo !== undefined ? backendInfo : fetchedBackendInfo;
  const release = resolveReleasePresentation(releaseIdentity, runtimeBackendInfo);
  const docsLine = docsVersionLine(release.version);
  const installedDocsUrl = `/docs/${docsLine}/`;
  const sourceDocsUrl = documentationSourceUrl(release.console);
  const [activeCategory, setActiveCategory] = React.useState<DocsCategoryId>('use');
  const [searchQuery, setSearchQuery] = React.useState('');
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const category = DOC_CATEGORIES.find((candidate) => candidate.id === activeCategory)!;

  const results = React.useMemo(() => {
    const categories = normalizedQuery ? DOC_CATEGORIES : [category];
    return categories.flatMap((candidate) =>
      candidate.articles
        .filter((article) => includesQuery(article, normalizedQuery))
        .map((article) => ({ article, category: candidate })),
    );
  }, [category, normalizedQuery]);

  const chooseCategory = (id: DocsCategoryId) => {
    setActiveCategory(id);
    setSearchQuery('');
  };

  return (
    <PageContainer variant="wide" className="space-y-6" data-testid="docs-page">
      <PageHeader
        breadcrumb={[{ label: 'Help' }, { label: 'Documentation' }]}
        title="Help Center"
        description="Guidance for using, administering, and operating this installed version of Agentic SOC."
        icon={BookOpenText}
        meta={
          <Badge variant={release.channel === 'stable' ? 'success' : 'warning'}>
            v{release.version} · {release.channelLabel}
          </Badge>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={installedDocsUrl}>
                Browse all guides
                <ArrowRight aria-hidden />
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a
                href={sourceDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View the matching documentation source on GitHub"
              >
                Source
                <ArrowUpRight aria-hidden />
              </a>
            </Button>
          </div>
        }
      />

      <section
        aria-label="Installed documentation"
        className="grid gap-4 border-y border-border py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
            <BookOpenText className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-foreground">Documentation for this installation</p>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              These articles ship with the application and remain available from the same host.
            </p>
            {release.mismatch ? (
              <p className="mt-2 text-xs leading-relaxed text-warning-text" role="status">
                Console and backend build identities differ. This session is treated as Testing;
                these guides still match the installed Console bundle.
              </p>
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-5 text-xs sm:text-right">
          <div>
            <dt className="text-muted-foreground">Application</dt>
            <dd className="mt-0.5 font-mono font-medium text-foreground">v{release.version}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Docs line</dt>
            <dd className="mt-0.5 font-mono font-medium text-foreground">{docsLine}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Channel</dt>
            <dd className="mt-0.5 font-medium text-foreground">{release.channelLabel}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="help-directory-title" className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="help-directory-title" className="text-xl font-semibold text-foreground">
              Find guidance
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Start with product workflows, or search the featured guide directory. Full-text
              search is available after you open any guide.
            </p>
          </div>
          <div className="relative w-full sm:max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <label htmlFor="docs-search" className="sr-only">
              Search documentation
            </label>
            <Input
              id="docs-search"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search featured guides…"
              className="h-10 pl-9 pr-9"
              aria-controls="docs-results"
            />
            {searchQuery ? (
              <button
                type="button"
                aria-label="Clear documentation search"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        <div className="grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <nav aria-label="Documentation categories" className="min-w-0">
            <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-1">
              {DOC_CATEGORIES.map((candidate) => {
                const Icon = candidate.icon;
                const selected = candidate.id === activeCategory && !normalizedQuery;
                return (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => chooseCategory(candidate.id)}
                      aria-current={selected ? 'page' : undefined}
                      className={cn(
                        'group flex w-full items-center gap-3 rounded-md border-l-2 px-3 py-2.5 text-left',
                        'transition-[background-color,border-color,color] duration-150 ease-premium',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        'motion-reduce:transition-none',
                        selected
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-transparent text-muted-foreground hover:border-border-strong hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          selected ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{candidate.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {candidate.articles.length} guides
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 border-t border-border lg:border-l lg:border-t-0 lg:pl-6">
            <div className="flex min-h-14 flex-wrap items-start justify-between gap-3 py-3 lg:pt-0">
              <div>
                <h3 className="text-lg font-semibold text-foreground">
                  {normalizedQuery ? 'Search results' : category.title}
                </h3>
                <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
                  {normalizedQuery
                    ? `Matching “${searchQuery.trim()}” across the featured guide directory.`
                    : category.description}
                </p>
              </div>
              <span
                className="text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
                aria-atomic="true"
              >
                {results.length} {results.length === 1 ? 'guide' : 'guides'}
              </span>
            </div>

            <ul id="docs-results" className="divide-y divide-border border-y border-border">
              {results.map(({ article, category: resultCategory }) => (
                <li key={`${resultCategory.id}-${article.path}`}>
                  <a
                    href={docsArticleUrl(article.path, release.version)}
                    className={cn(
                      'group grid min-h-24 gap-3 px-1 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-3',
                      'transition-colors duration-150 hover:bg-muted/40',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      'motion-reduce:transition-none',
                    )}
                  >
                    <span className="min-w-0">
                      {normalizedQuery ? (
                        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-primary">
                          {resultCategory.title}
                        </span>
                      ) : null}
                      <span className="block font-medium text-foreground group-hover:text-primary">
                        {article.title}
                      </span>
                      <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                        {article.description}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-primary">
                      Open guide
                      <ArrowRight
                        className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none"
                        aria-hidden
                      />
                    </span>
                  </a>
                </li>
              ))}
            </ul>

            {results.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center border-b border-border px-6 text-center">
                <CircleHelp className="size-6 text-muted-foreground" aria-hidden />
                <p className="mt-3 font-medium text-foreground">No matching guidance</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  Try a feature name such as cases, playbooks, backup, or permissions.
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => setSearchQuery('')}>
                  Clear search
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <aside
        aria-label="Other documentation versions"
        className="flex flex-col gap-3 border-t border-border pt-4 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div>
          <p className="font-medium text-foreground">Planning an upgrade or reviewing future work?</p>
          <p className="mt-0.5 text-muted-foreground">
            External documentation may describe a different application version. This installed guide remains authoritative here.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
          {release.channel === 'stable' ? (
            <a
              href={PUBLIC_STABLE_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Latest Stable
              <ArrowUpRight className="size-3.5" aria-hidden />
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              Stable site publishes with the first Stable release
            </span>
          )}
          <a
            href={DEVELOPMENT_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Development source
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        </div>
      </aside>
    </PageContainer>
  );
}
