/**
 * The What's new welcome (Round 16 SPEC D7, [wn] §4.3): a short, quiet dialog shown once
 * after an update.
 *
 * - 40rem wide, the shared scrim and panel; below 640 px it fills the screen.
 * - Focus starts on the title (the content is a list, so no control is focused first);
 *   closing returns focus to the main landmark (`#socMain`), since an automatic dialog
 *   has no invoker. Escape, an outside press, Got it, See all changes and Open all close
 *   it, and the host writes the marker once for any of them.
 * - At most five highlights: an area tile, the title and a one-line summary. When two or
 *   more have a screenshot, pressing a row shows its screenshot as the hero
 *   (`aria-pressed`); there is no carousel and nothing moves on its own.
 * - Open is a sibling link, shown only when the viewer may open that page.
 * - The description is the one summary sentence (the rest is a list, [wn] §3.3).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { NavOpts } from '@/lib/types';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/ui/dialog';
import type { PageId } from '../nav';
import { pageHash } from '../router';
import { AREA_ICON } from './area-icons';
import type { WhatsNewPlan } from './decide';
import { InlineText } from './InlineText';
import { AREA_LABEL, shortDate } from './notes';
import { ReleaseFigure } from './ReleaseFigure';

export interface WhatsNewTarget {
  page: PageId;
  opts?: NavOpts;
}

export interface WhatsNewDialogProps {
  open: boolean;
  plan: WhatsNewPlan;
  /** The running Console version (the Help Center line images are served from). */
  runningVersion: string;
  /** "Testing" or "Stable", from the release presentation. */
  channelLabel: string;
  /** Whether "Open" may be offered for a highlight's page. */
  canOpen: (page: string | null) => page is PageId;
  /** Any close; `target` when the person chose a page to go to. */
  onClose: (target?: WhatsNewTarget) => void;
}

export function whatsNewTitle(plan: WhatsNewPlan): string {
  return plan.kind === 'welcome'
    ? `Welcome to Agentic SOC ${plan.release.version}`
    : `What's new in Agentic SOC ${plan.release.version}`;
}

export function WhatsNewDialog({
  open,
  plan,
  runningVersion,
  channelLabel,
  canOpen,
  onClose,
}: WhatsNewDialogProps): React.ReactElement {
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const shots = plan.highlights.filter((highlight) => highlight.screenshot);
  const pressable = shots.length > 1;
  const [selectedId, setSelectedId] = React.useState<string | null>(shots[0]?.id ?? null);
  const hero = plan.highlights.find((highlight) => highlight.id === selectedId)?.screenshot ?? null;
  const released = shortDate(plan.release.date);
  const eyebrow = ["What's new", `v${plan.release.version}`, released ?? channelLabel].join(' · ');
  const summary =
    plan.kind === 'welcome'
      ? plan.release.summary
      : `${plan.updates.length === 1 ? 'One update' : `${plan.updates.length} updates`} since you last looked.`;

  const go = (event: React.MouseEvent<HTMLAnchorElement>, target: WhatsNewTarget) => {
    // A modified click opens a new tab as a link should; a plain one closes and navigates.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onClose(target);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        data-testid="whats-new-dialog"
        className={cn(
          'flex max-w-[40rem] flex-col gap-0 overflow-hidden p-0',
          'max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:rounded-none max-sm:border-0',
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById('socMain')?.focus();
        }}
      >
        <div className="space-y-1.5 px-6 pb-4 pr-12 pt-6">
          <p className="text-xs font-medium text-muted-foreground" data-testid="whats-new-eyebrow">
            {eyebrow}
          </p>
          <DialogTitle ref={titleRef} tabIndex={-1} className="text-lg leading-tight focus-visible:outline-none">
            {whatsNewTitle(plan)}
          </DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5">
          {hero ? <ReleaseFigure screenshot={hero} version={runningVersion} eager /> : null}
          {plan.highlights.length ? (
            <ul className="divide-y divide-border/70 border-y border-border/70" aria-label="Highlights">
              {plan.highlights.map((highlight) => {
                const Icon = AREA_ICON[highlight.area];
                const selected = pressable && highlight.id === selectedId;
                const body = (
                  <>
                    <span
                      className={cn(
                        'mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md',
                        selected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                      aria-hidden
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{highlight.title}</span>
                      <span className="mt-0.5 block text-sm text-muted-foreground">
                        <InlineText text={highlight.summary} />
                      </span>
                      <span className="sr-only">{`, ${AREA_LABEL[highlight.area]}`}</span>
                    </span>
                  </>
                );
                const page = highlight.open;
                return (
                  <li key={highlight.id} className="flex items-start gap-2 py-3">
                    {pressable && highlight.screenshot ? (
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setSelectedId(highlight.id)}
                        className={cn(
                          'flex min-w-0 flex-1 items-start gap-3 rounded-md p-1 text-left',
                          'transition-colors duration-150 hover:bg-hover motion-reduce:transition-none',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        )}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-start gap-3 p-1">{body}</div>
                    )}
                    {canOpen(page) ? (
                      <Button asChild variant="ghost" size="sm" className="mt-0.5 shrink-0">
                        <a
                          href={pageHash(page)}
                          onClick={(event) => go(event, { page })}
                          aria-label={`Open ${highlight.title}`}
                        >
                          Open
                        </a>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button asChild variant="outline">
            <a
              href={pageHash('whats_new', { v: plan.release.version })}
              onClick={(event) => go(event, { page: 'whats_new', opts: { v: plan.release.version } })}
            >
              See all changes
            </a>
          </Button>
          <Button type="button" onClick={() => onClose()}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
