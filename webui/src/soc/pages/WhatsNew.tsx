/**
 * Communication, What's new: the release tracker (Round 16 SPEC D5, D7, [wn] §4.4).
 *
 * Every release this Console ships notes for, newest first: its title, status and summary,
 * links to its Help Center record, area filters, a search, and its updates grouped by
 * date. Each highlight shows its kind, summary, details and screenshot, with Open (when
 * the viewer may open that page), Read more and Copy link (`#/whats_new?v=&h=`). Items
 * newer than the marker the person had when the page opened read "New to you". The
 * header holds the personal switch and "Show the welcome screen".
 *
 * The notes are static content bundled with this installation (a lazy chunk), so the page
 * needs no permission and makes no request; only Open is gated, by the same rule as the
 * navigation. Every string renders as text.
 */
import * as React from 'react';
import { ArrowUpRight, ChevronRight, Search, X } from 'lucide-react';

import { cn } from '@/lib/cn';
import { docsArticleUrl } from '@/lib/docs-url';
import { CONSOLE_RELEASE_IDENTITY, resolveReleasePresentation } from '@/lib/release';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { useAuth } from '@/soc/auth';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { usePrefs } from '@/soc/prefs';
import { useRoute } from '@/soc/router';
import { HighlightRow, highlightDomId } from '@/soc/whats-new/HighlightRow';
import {
  AREA_LABEL,
  RELEASE_NOTES,
  allUpdates,
  pageOpenable,
  shortDate,
  takeMarkerBeforeClose,
  type HighlightArea,
  type NotesHighlight,
  type NotesRelease,
} from '@/soc/whats-new/notes';
import { ReleaseRail } from '@/soc/whats-new/ReleaseRail';
import WhatsNewHost from '@/soc/whats-new/WhatsNewHost';

// One chunk for the page and the welcome: the entry gate loads this module for the host.
export { WhatsNewHost };

const PAGE_HELP =
  'Every Agentic SOC release with highlights, details and screenshots. These notes ship with this installation.';

function matches(highlight: NotesHighlight, query: string): boolean {
  if (!query) return true;
  return [highlight.title, highlight.summary, ...highlight.details].join(' ').toLocaleLowerCase().includes(query);
}

/** The update ids newer than `marker` (none when the marker is absent or unknown). */
function newerThan(marker: string | null | undefined): Set<string> {
  const ordered = allUpdates(RELEASE_NOTES);
  const at = marker ? ordered.findIndex(({ update }) => update.id === marker) : -1;
  return new Set(at > 0 ? ordered.slice(0, at).map(({ update }) => update.id) : []);
}

export default function WhatsNew(): React.ReactElement {
  const { opts } = useRoute();
  const { prefs, loaded, patchMisc } = usePrefs();
  const { hasPermission } = useAuth();
  const release = resolveReleasePresentation(CONSOLE_RELEASE_IDENTITY, null);
  const releases = RELEASE_NOTES.releases;

  const requested = releases.find((candidate) => candidate.version === opts?.v)?.version;
  const [selected, setSelected] = React.useState<string>(requested ?? releases[0]?.version ?? '');
  React.useEffect(() => {
    if (requested) setSelected(requested);
  }, [requested]);
  const current: NotesRelease | undefined = releases.find((candidate) => candidate.version === selected) ?? releases[0];

  // The marker the person had when the page opened: what the dialog saw if it just closed
  // ("See all changes"), else the stored one once preferences are read.
  const [baseline, setBaseline] = React.useState<string | null | undefined>(() => takeMarkerBeforeClose());
  React.useEffect(() => {
    if (baseline === undefined && loaded) setBaseline((prefs.misc?.whats_new_seen as string | undefined) ?? null);
  }, [baseline, loaded, prefs.misc]);
  const unseen = React.useMemo(() => newerThan(baseline), [baseline]);

  const [area, setArea] = React.useState<HighlightArea | 'all'>('all');
  const [query, setQuery] = React.useState('');
  const [welcome, setWelcome] = React.useState(false);
  const normalized = query.trim().toLocaleLowerCase();
  const areas = React.useMemo(
    () => [...new Set(current?.updates.flatMap((update) => update.highlights.map((h) => h.area)) ?? [])],
    [current],
  );
  const visible = React.useMemo(
    () =>
      (current?.updates ?? [])
        .map((update) => ({
          update,
          highlights: update.highlights.filter((h) => (area === 'all' || h.area === area) && matches(h, normalized)),
        }))
        .filter((group) => group.highlights.length),
    [area, current, normalized],
  );
  const shown = visible.reduce((total, group) => total + group.highlights.length, 0);

  // `#/whats_new?v=&h=`: clear filters that would hide the highlight, then scroll to it
  // and move focus there once it is drawn.
  const target = opts?.h && current ? highlightDomId(current.version, opts.h) : null;
  React.useEffect(() => {
    if (!opts?.h) return;
    setArea('all');
    setQuery('');
  }, [opts?.h, opts?.v]);
  React.useEffect(() => {
    if (!target) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(target);
      if (!element) return;
      element.scrollIntoView?.({ block: 'start' });
      element.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [target, shown]);

  const autoOn = prefs.misc?.whats_new_auto !== false;
  let firstFigure = true;

  return (
    <PageContainer variant="wide" data-testid="whats-new-page">
      <PageHeader
        title="What's new"
        help={PAGE_HELP}
        actions={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm text-muted-foreground" data-testid="whats-new-release-line">
              {`Running v${release.version} · ${release.channelLabel}`}
            </span>
            <div className="flex items-center gap-2">
              <Switch
                id="whats-new-page-auto"
                checked={autoOn}
                onCheckedChange={(on) => void patchMisc({ whats_new_auto: on })}
              />
              <Label htmlFor="whats-new-page-auto" className="text-sm font-normal text-foreground">
                Show after updates
              </Label>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => setWelcome(true)}>
              Show the welcome screen
            </Button>
          </div>
        }
      />

      {!current ? (
        <p className="text-sm text-muted-foreground">No release notes ship with this installation.</p>
      ) : (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[15rem_minmax(0,1fr)]">
          <ReleaseRail
            releases={releases}
            selected={current.version}
            runningVersion={release.version}
            onSelect={(version) => {
              setSelected(version);
              setArea('all');
            }}
          />

          <div className="min-w-0 space-y-5" data-testid="whats-new-release">
            <section aria-labelledby="whats-new-release-title" className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="whats-new-release-title" className="text-lg font-semibold text-foreground">
                  Agentic SOC {current.version}
                </h2>
                {current.status === 'testing' ? (
                  <Badge variant="warning">Testing candidate</Badge>
                ) : (
                  <Badge variant="success">{`Released ${shortDate(current.date) ?? ''}`.trim()}</Badge>
                )}
                {current.version === release.version ? <Badge variant="secondary">Installed here</Badge> : null}
              </div>
              <p className="text-md font-medium text-foreground">{current.title}</p>
              <p className="max-w-3xl text-sm text-muted-foreground">{current.summary}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button asChild variant="outline" size="sm">
                  <a href={docsArticleUrl(current.docs, release.version)}>
                    Release record
                    <ArrowUpRight aria-hidden />
                  </a>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href={docsArticleUrl('operations/upgrades/', release.version)}>
                    Upgrade notes
                    <ArrowUpRight aria-hidden />
                  </a>
                </Button>
              </div>
            </section>

            <div className="flex flex-col gap-3 border-y border-border/70 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div role="group" aria-label="Filter by area" className="flex flex-wrap gap-1.5">
                {(['all', ...areas] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={area === option ? 'secondary' : 'ghost'}
                    aria-pressed={area === option}
                    onClick={() => setArea(option)}
                    className={cn('h-8', area === option ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                  >
                    {option === 'all' ? 'All' : AREA_LABEL[option]}
                  </Button>
                ))}
              </div>
              <div className="relative w-full lg:w-72">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <label htmlFor="whats-new-search" className="sr-only">
                  Search this release
                </label>
                <Input
                  id="whats-new-search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search this release"
                  className="h-9 pl-9 pr-9"
                />
                {query ? (
                  <button
                    type="button"
                    aria-label="Clear the search"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
            <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite" aria-atomic="true">
              {shown === 1 ? '1 highlight' : `${shown.toLocaleString('en-US')} highlights`}
            </p>

            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground">No highlight matches. Clear the search or choose All.</p>
            ) : (
              visible.map(({ update, highlights }) => (
                <section key={update.id} aria-labelledby={`update-${update.id}`} className="space-y-1">
                  <h3 id={`update-${update.id}`} className="text-sm font-semibold text-muted-foreground">
                    {`${shortDate(update.date) ?? 'Not yet released'} · ${update.title}`}
                  </h3>
                  <div>
                    {highlights.map((highlight) => {
                      const eager = Boolean(highlight.screenshot) && firstFigure;
                      if (highlight.screenshot) firstFigure = false;
                      return (
                        <HighlightRow
                          key={highlight.id}
                          highlight={highlight}
                          version={current.version}
                          runningVersion={release.version}
                          isNew={unseen.has(update.id)}
                          openable={pageOpenable(highlight.open, hasPermission)}
                          eagerFigure={eager}
                          highlighted={opts?.h === highlight.id}
                        />
                      );
                    })}
                  </div>
                </section>
              ))
            )}

            {current.records.length ? (
              <details className="group border-t border-border/70 pt-4" data-testid="whats-new-records-group">
                <summary
                  className={cn(
                    'inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-foreground',
                    'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden',
                  )}
                >
                  <ChevronRight className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
                  Earlier release records
                  <span className="text-muted-foreground">{`(${current.records.length})`}</span>
                </summary>
                  <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
                    {`These versions were never a supported installation. Their changes are part of ${current.version}.`}
                  </p>
                  <ul className="mt-2 divide-y divide-border/70" data-testid="whats-new-records">
                    {current.records.map((record) => (
                      <li key={record.version} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                        <a
                          href={docsArticleUrl(record.docs, release.version)}
                          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                        >
                          Agentic SOC {record.version}
                        </a>
                        <span className="min-w-0 flex-1 text-sm text-muted-foreground">{record.summary}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{shortDate(record.date)}</span>
                      </li>
                    ))}
                  </ul>
              </details>
            ) : null}
          </div>
        </div>
      )}

      {welcome ? <WhatsNewHost force onDone={() => setWelcome(false)} /> : null}
    </PageContainer>
  );
}
