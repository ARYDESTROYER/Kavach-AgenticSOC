/**
 * The version rail of the Communication, What's new page (Round 16 WP07, [wn] §4.4): a
 * sticky list of releases from 1,280 px, a version select below it. The running version
 * reads "Installed here".
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { shortDate, type NotesRelease } from './notes';

export interface ReleaseRailProps {
  releases: NotesRelease[];
  selected: string;
  runningVersion: string;
  onSelect: (version: string) => void;
}

function releaseLine(release: NotesRelease, runningVersion: string): string {
  const when = release.status === 'testing' ? 'Testing' : shortDate(release.date) ?? 'Released';
  return release.version === runningVersion ? `${when} · Installed here` : when;
}

export function ReleaseRail({ releases, selected, runningVersion, onSelect }: ReleaseRailProps): React.ReactElement {
  return (
    <>
      <nav
        aria-label="Releases"
        className="hidden xl:sticky xl:top-[calc(var(--header-h,3.5rem)+1rem)] xl:block xl:self-start"
      >
        <ul className="space-y-1">
          {releases.map((release) => {
            const current = release.version === selected;
            return (
              <li key={release.version}>
                <button
                  type="button"
                  onClick={() => onSelect(release.version)}
                  aria-current={current ? 'true' : undefined}
                  data-active={current ? '' : undefined}
                  className={cn(
                    'nav-tint flex w-full flex-col rounded-md px-3 py-2 text-left',
                    'transition-colors duration-150 ease-premium motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    current ? 'bg-primary/10 text-primary dark:bg-accent' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <span className="text-sm font-medium">Agentic SOC {release.version}</span>
                  <span className="text-xs text-muted-foreground">{releaseLine(release, runningVersion)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="xl:hidden">
        <Select value={selected} onValueChange={onSelect}>
          <SelectTrigger className="h-9 w-full sm:w-72" aria-label="Release">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {releases.map((release) => (
              <SelectItem key={release.version} value={release.version}>
                {`Agentic SOC ${release.version} · ${releaseLine(release, runningVersion)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
