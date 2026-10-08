/**
 * Global Command Palette (Cmd/Ctrl-K) — the keyboard-first jump + search surface
 * for the SOC console (Round-2 W7c).
 *
 * A single cmdk dialog, mounted ONCE in the shell, that:
 *   (a) starts with RBAC-filtered top-level destinations and progressively reveals
 *       child pages + Settings sections after the operator types a query;
 *   (b) debounce-queries GET /api/search?q= for cases + sources and lets the
 *       operator open one;
 *   (c) offers quick actions (New chat, Toggle theme, Go to Settings, Enable demo
 *       mode — admin only) and the chat entries (Ask AI: <text>, Search chats, Open
 *       Reports — SPEC §10.4a), which load as a LAZY chunk so the entry stays small;
 *   (d) remembers recently-jumped targets (localStorage) and surfaces them first.
 *
 * SECURITY (#9): every case/source title, entity value and source name returned by
 * the search API is operator-/log-derived UNTRUSTED data — it is rendered here as
 * PLAIN text only (cmdk renders children as text), never as markup. cmdk's own
 * fuzzy filter is DISABLED for the remote results (`shouldFilter={false}`) so the
 * server's ranking is authoritative; nav/action items are filtered client-side.
 */
import * as React from 'react';
import {
  ArrowRight,
  Briefcase,
  Database,
  FlaskConical,
  MessageSquarePlus,
  Moon,
  Settings as SettingsIcon,
  Sun,
  History,
  type LucideIcon,
} from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from '@/ui/command';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/ui/dialog';
import { api } from '@/lib/api';
import type { NavOpts, SearchResult } from '@/lib/types';
import { useAuth } from '@/soc/auth';
import { usePrefs } from '@/soc/prefs';
import { useTheme } from '@/soc/theme';
import { useDemo } from '@/soc/demo';
import { NAV_FOOTER_ITEMS, NAV_GROUPS, isPageId, type PageId } from '@/soc/nav';
import type { Navigate } from '@/soc/router';
// The always-on command palette needs only the section SEARCH metadata, never a
// Settings renderer — import from the COMPONENT-FREE meta module so the heavy Settings
// component tree stays out of the first-paint entry chunk (Round-5 Coupling-A).
import { searchJumpTargets } from '@/soc/pages/settings/settings-sections-meta';

// The chat entries + chat search (chat revamp): lazy, never in the entry chunk.
const PaletteSearch = React.lazy(() => import('@/soc/chat/report/PaletteSearch'));

const RECENTS_KEY = 'tlsoc.cmdk.recents';
const RECENTS_MAX = 6;

/** A recently-jumped palette target persisted in localStorage. */
interface RecentItem {
  page: PageId;
  label: string;
}

function loadRecents(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentItem =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as RecentItem).page === 'string' &&
          isPageId((r as RecentItem).page) &&
          typeof (r as RecentItem).label === 'string',
      )
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function pushRecent(item: RecentItem): void {
  try {
    const next = [item, ...loadRecents().filter((r) => r.page !== item.page)].slice(
      0,
      RECENTS_MAX,
    );
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* best-effort — recents are cosmetic */
  }
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Navigate to a page (rail + Settings-section targets resolve through this). */
  onNavigate: Navigate;
}

/**
 * The mounted-once command palette. Owns its own query state + debounced remote
 * search; resets when the dialog closes.
 */
export function CommandPalette({ open, onOpenChange, onNavigate }: CommandPaletteProps) {
  const { hasPermission } = useAuth();
  const { setThemeMode } = usePrefs();
  const { isDark } = useTheme();
  const { active: demoActive, refresh: refreshDemo } = useDemo();

  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<SearchResult | null>(null);
  const [recents, setRecents] = React.useState<RecentItem[]>([]);

  // Refresh the recents list each time the palette opens; clear the query on close.
  React.useEffect(() => {
    if (open) {
      setRecents(loadRecents());
    } else {
      setQuery('');
      setResults(null);
    }
  }, [open]);

  // Debounced remote search (cases + sources). A short/blank query clears results
  // (the nav/quick-actions still render). Stale responses are dropped via a token.
  React.useEffect(() => {
    if (!open) return undefined;
    const term = query.trim();
    if (term.length < 2) {
      setResults(null);
      return undefined;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void api
        .search(term, 20)
        .then((res) => {
          if (alive) setResults(res);
        })
        .catch(() => {
          if (alive) setResults(null);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query, open]);

  // Navigate + record the jump + close. Settings-section nav ids are valid PageIds.
  const go = React.useCallback(
    (page: PageId, label: string, opts?: NavOpts) => {
      pushRecent({ page, label });
      // Plain jumps keep the one-argument call the shell (and its tests) rely on.
      if (opts) onNavigate(page, opts);
      else onNavigate(page);
      onOpenChange(false);
    },
    [onNavigate, onOpenChange],
  );

  // RBAC-filtered nav jump targets (mirrors the shell): each group's visible top-level
  // items PLUS their disclosure children — each child gated on its OWN perm — flattened
  // so EVERY routable page is a Cmd-K target, not just the rail hosts. Without this the
  // children-only destinations (Cost, Models, Baseline, Batch jobs, Standup, Knowledge,
  // Memory, Investigate, Playbooks) were unreachable from the palette. A parent host and
  // a child can share a PageId (e.g. `chat`), so targets carry a unique `key`/`value`
  // (host = `nav-<id>`, child = `navc-<parent>-<id>`) — the `nav-<id>` host values are
  // relied on by the command-palette spec.
  const navGroups = React.useMemo<
    {
      id: string;
      label: string;
      targets: {
        id: PageId;
        label: string;
        icon?: LucideIcon;
        key: string;
        depth: 'host' | 'child';
      }[];
    }[]
  >(
    () =>
      [
        ...NAV_GROUPS,
        ...(NAV_FOOTER_ITEMS.length > 0
          ? [{ id: 'help', label: 'Help', items: NAV_FOOTER_ITEMS }]
          : []),
      ].map((group) => {
        const targets: {
          id: PageId;
          label: string;
          icon?: LucideIcon;
          key: string;
          depth: 'host' | 'child';
        }[] = [];
        for (const item of group.items) {
          if (item.perm && !hasPermission(item.perm.resource, item.perm.action)) continue;
          targets.push({
            id: item.id,
            label: item.label,
            icon: item.icon,
            key: `nav-${item.id}`,
            depth: 'host',
          });
          for (const child of item.children ?? []) {
            if (child.perm && !hasPermission(child.perm.resource, child.perm.action)) continue;
            targets.push({
              id: child.id,
              label: child.label,
              icon: child.icon ?? item.icon,
              key: `navc-${item.id}-${child.id}`,
              depth: 'child',
            });
          }
        }
        return { id: group.id, label: group.label, targets };
      }).filter((g) => g.targets.length > 0),
    [hasPermission],
  );

  const canManageSettings = hasPermission('settings', 'manage');

  // Settings sections + setting-level cards as jump targets (Round-5 Sett-C), sourced
  // from the ONE lifted registry with the SAME RBAC filter as the Settings rail. The
  // blank discovery state intentionally shows none of this deep structure; a term
  // reveals the matching section/card and jumps straight to it via
  // #/settings?s=<section>&a=<anchor>. Capped so the palette stays scannable.
  const settingsTargets = React.useMemo(
    () => searchJumpTargets(query, hasPermission).slice(0, 8),
    [query, hasPermission],
  );

  // We run cmdk with shouldFilter=false so the SERVER ranking of remote (case/source)
  // hits is authoritative — cmdk's own fuzzy filter would otherwise hide a hit whose
  // title doesn't literally contain the typed term. The local (nav/action/recent)
  // items are filtered by this simple substring match instead.
  const term = query.trim().toLowerCase();
  const localMatch = React.useCallback(
    (...parts: string[]): boolean => {
      if (!term) return true;
      return parts.join(' ').toLowerCase().includes(term);
    },
    [term],
  );
  const showRecents = term.length === 0 && recents.length > 0;
  const isDiscoveryState = term.length === 0;
  const res = results;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* hideClose: the palette's full-bleed search input owns the top row, so the
          built-in top-right X would overlap it — suppress it (#14). */}
      <DialogContent hideClose className="overflow-hidden p-0 sm:max-w-[640px]">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Jump to a page, search cases and sources, or run a quick action.
        </DialogDescription>
        {/* shouldFilter=false: the SERVER ranks remote case/source hits; the local
            nav/action/recent items are filtered in render by `localMatch`. */}
        <Command shouldFilter={false} loop>
          <CommandInput
            placeholder="Search cases, sources, settings, or actions…"
            value={query}
            onValueChange={setQuery}
            /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
            autoFocus
          />
          <CommandList className="max-h-[min(60dvh,420px)]">
            <CommandEmpty>No results.</CommandEmpty>

            {/* Recently visited (only on an empty query). */}
            {showRecents ? (
              <CommandGroup heading="Recent">
                {recents.map((r) => (
                  <CommandItem
                    key={`recent-${r.page}`}
                    value={`recent ${r.label} ${r.page}`}
                    onSelect={() => go(r.page, r.label)}
                  >
                    <History aria-hidden />
                    <span>{r.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {/* Remote: case hits (UNTRUSTED text → plain). */}
            {res && res.cases.length > 0 ? (
              <CommandGroup heading="Cases">
                {res.cases.map((c) => (
                  <CommandItem
                    key={`case-${c.id}`}
                    // Force a match (server already ranked) — include the id so it is unique.
                    value={`case ${c.id} ${c.case_number ?? ''} ${c.title ?? ''} ${c.entity ?? ''}`}
                    onSelect={() => {
                      pushRecent({ page: 'cases', label: c.title || c.id });
                      onNavigate('cases', { caseId: c.id });
                      onOpenChange(false);
                    }}
                  >
                    <Briefcase aria-hidden />
                    <span className="truncate">{c.title || c.id}</span>
                    <CommandShortcut className="tracking-normal">
                      {c.case_number || c.id}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {/* Remote: source hits (UNTRUSTED text → plain). */}
            {res && res.sources.length > 0 ? (
              <CommandGroup heading="Sources">
                {res.sources.map((s) => (
                  <CommandItem
                    key={`source-${s.id}`}
                    value={`source ${s.id} ${s.label ?? ''} ${s.source_type ?? ''}`}
                    onSelect={() => go('sources', s.label || s.id)}
                  >
                    <Database aria-hidden />
                    <span className="truncate">{s.label || s.id}</span>
                    {s.source_type ? (
                      <CommandShortcut className="tracking-normal">
                        {s.source_type}
                      </CommandShortcut>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            {(showRecents || (res && (res.cases.length || res.sources.length))) ? (
              <CommandSeparator />
            ) : null}

            <React.Suspense fallback={null}>
              <PaletteSearch query={query} go={go} />
            </React.Suspense>

            {/* Quick actions (filtered by the local substring match). */}
            <CommandGroup heading="Actions">
              {localMatch('new chat workspace investigate assistant') ? (
                <CommandItem value="action-new-chat" onSelect={() => go('chat', 'Workspace', { newChat: true })}>
                  <MessageSquarePlus aria-hidden />
                  <span>New chat</span>
                </CommandItem>
              ) : null}
              {localMatch('toggle theme dark light appearance') ? (
                <CommandItem
                  value="action-toggle-theme"
                  onSelect={() => {
                    setThemeMode(isDark ? 'light' : 'dark');
                    onOpenChange(false);
                  }}
                >
                  {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
                  <span>{isDark ? 'Switch to light mode' : 'Switch to dark mode'}</span>
                </CommandItem>
              ) : null}
              {localMatch('go to settings preferences configuration') ? (
                <CommandItem
                  value="action-go-settings"
                  onSelect={() => go('settings', 'Settings')}
                >
                  <SettingsIcon aria-hidden />
                  <span>Go to Settings</span>
                </CommandItem>
              ) : null}
              {canManageSettings &&
              !demoActive &&
              localMatch('enable demo mode synthetic sandbox') ? (
                <CommandItem
                  value="action-enable-demo"
                  onSelect={() => {
                    void api.demo
                      .enable()
                      .then(() => refreshDemo())
                      .catch(() => undefined);
                    onOpenChange(false);
                  }}
                >
                  <FlaskConical aria-hidden />
                  <span>Enable demo mode</span>
                </CommandItem>
              ) : null}
            </CommandGroup>

            {/* Settings sections + setting-level cards (RBAC-filtered, from the lifted
                settings-sections registry and intentionally search-only). Jumps write the FULL hash
                `#/settings?s=<section>&a=<anchor>` via the router's settings sub-target
                path — the deep-link + card highlight survive the hashchange. */}
            {!isDiscoveryState && settingsTargets.length > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup heading="Settings">
                  {settingsTargets.map((t) => {
                    const Icon = t.icon as LucideIcon;
                    const key = t.anchor ? `set-${t.section}-${t.anchor}` : `set-${t.section}`;
                    return (
                      <CommandItem
                        key={key}
                        value={key}
                        onSelect={() => {
                          pushRecent({ page: 'settings', label: t.label });
                          onNavigate('settings', { section: t.section, anchor: t.anchor });
                          onOpenChange(false);
                        }}
                      >
                        <Icon aria-hidden />
                        <span className="truncate">{t.label}</span>
                        {t.anchor ? (
                          <CommandShortcut className="tracking-normal">
                            {t.sectionTitle}
                          </CommandShortcut>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            ) : null}

            <CommandSeparator />

            {/* Nav targets (RBAC-filtered rail groups + their children + local match). */}
            {navGroups.map((group) => {
              const items = group.targets.filter(
                (t) =>
                  (!isDiscoveryState || t.depth === 'host') &&
                  localMatch('page', t.label, t.id),
              );
              if (!items.length) return null;
              return (
                <CommandGroup key={`nav-${group.id}`} heading={group.label}>
                  {items.map((t) => {
                    const Icon = t.icon;
                    return (
                      // `group` here is load-bearing: the ArrowRight below reveals via the
                      // `group-data-[selected=true]` variant, which needs an ancestor with
                      // the literal `group` class carrying cmdk's `data-selected`.
                      <CommandItem
                        key={t.key}
                        value={t.key}
                        className="group"
                        onSelect={() => go(t.id, t.label)}
                      >
                        {Icon ? <Icon aria-hidden /> : null}
                        <span>{t.label}</span>
                        <ArrowRight
                          className="ml-auto opacity-0 group-data-[selected=true]:opacity-60"
                          aria-hidden
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
          </CommandList>
          <div
            className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground"
            aria-hidden
          >
            <span>
              {isDiscoveryState
                ? 'Type to search every page, setting, case, and source'
                : 'Search results update as you type'}
            </span>
            <span className="hidden items-center gap-2 sm:flex">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Enter</kbd>
              open
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Esc</kbd>
              close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export default CommandPalette;
