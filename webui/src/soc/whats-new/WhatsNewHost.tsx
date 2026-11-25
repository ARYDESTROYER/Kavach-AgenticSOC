/**
 * The lazy What's new host (Round 16 SPEC D7, [wn] §4.2 and §4.3).
 *
 * Loaded by the entry gate when the person's marker differs from the newest update id,
 * and by the Communication, What's new page ("Show the welcome screen", `force`). It
 * decides what to show ({@link decideWhatsNew}); this browser's fallback copy of the
 * marker counts as seen. It waits while the page shows one record (a session that starts
 * on a deep link defers to the next page that is not one) and while any other dialog is
 * open (re-authentication, the command palette, an update's progress, any modal), then
 * shows the dialog. On any close it writes the marker once through the audited
 * preferences route; when that write fails, this browser keeps a copy
 * (`soc.whatsNew.seen:<user>`) so the same browser does not show it again. A failure to
 * decide, load or save never reaches the shell: no toast, no error.
 */
import * as React from 'react';

import { CONSOLE_RELEASE_IDENTITY, resolveReleasePresentation } from '@/lib/release';
import { useAuth } from '../auth';
import type { PageId } from '../nav';
import { usePrefs } from '../prefs';
import { useNavigateOptional, useRoute } from '../router';
import { decideWhatsNew, type WhatsNewPlan } from './decide';
import {
  RELEASE_NOTES,
  opensRecord,
  pageOpenable,
  readSeenMirror,
  rememberMarkerBeforeClose,
  seenMirrorKey,
} from './notes';
import { WhatsNewDialog, type WhatsNewTarget } from './WhatsNewDialog';

/** How often the host looks again while another dialog is open. */
const OTHER_DIALOG_POLL_MS = 1_000;

/** After an update the page the person landed on shows first; the welcome follows. */
export const WHATS_NEW_OPEN_DELAY_MS = 1_500;

/** True while any other modal surface is open (Radix dialogs and alert dialogs). */
export function anotherDialogOpen(root: ParentNode = document): boolean {
  return Boolean(
    root.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'),
  );
}

export interface WhatsNewHostProps {
  /** Show the welcome even when the marker is current (a re-open from the page). */
  force?: boolean;
  /** Called once the dialog closed, or at once when there is nothing to show. */
  onDone?: () => void;
  /** How long the landing page shows before the welcome opens (tests pass 0). */
  openDelayMs?: number;
}

export default function WhatsNewHost({
  force = false,
  onDone,
  openDelayMs = WHATS_NEW_OPEN_DELAY_MS,
}: WhatsNewHostProps): React.ReactElement | null {
  const { prefs, patchMisc } = usePrefs();
  const { username, hasPermission } = useAuth();
  const { opts } = useRoute();
  const navigate = useNavigateOptional();
  const latest = RELEASE_NOTES.latest;
  // The marker as it was when the host mounted: the dialog's content never changes under
  // the person while it is open, even after the close writes the new marker. A copy this
  // browser kept after a failed save counts as having seen the newest update.
  const [marker] = React.useState<unknown>(() =>
    readSeenMirror(username) === latest ? latest : prefs.misc?.whats_new_seen,
  );
  const [plan] = React.useState<WhatsNewPlan | null>(() =>
    decideWhatsNew(RELEASE_NOTES, marker, { has: hasPermission, force }),
  );
  const [open, setOpen] = React.useState(false);
  const closed = React.useRef(false);
  const done = React.useRef(onDone);
  done.current = onDone;
  const onRecord = !force && opensRecord(opts);
  const release = resolveReleasePresentation(CONSOLE_RELEASE_IDENTITY, null);
  // A re-open from the page is immediate; after an update the landing page paints first.
  const [settled, setSettled] = React.useState(force || openDelayMs <= 0);

  React.useEffect(() => {
    if (!plan) done.current?.();
  }, [plan]);

  React.useEffect(() => {
    if (settled || !plan) return undefined;
    const timer = window.setTimeout(() => setSettled(true), openDelayMs);
    return () => window.clearTimeout(timer);
  }, [plan, settled, openDelayMs]);

  React.useEffect(() => {
    // Never over a record the person opened, nor over another dialog: look again until
    // they have moved on.
    if (!plan || !settled || open || closed.current || onRecord) return undefined;
    if (!anotherDialogOpen()) {
      setOpen(true);
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (anotherDialogOpen()) return;
      window.clearInterval(timer);
      setOpen(true);
    }, OTHER_DIALOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [plan, settled, onRecord, open]);

  const close = React.useCallback(
    (target?: WhatsNewTarget) => {
      if (closed.current) return;
      closed.current = true;
      setOpen(false);
      // "See all changes": the page marks as new what this person had not seen yet.
      if (target?.page === 'whats_new') rememberMarkerBeforeClose(marker);
      if (target) navigate(target.page, target.opts);
      done.current?.();
      if (marker === latest) return;
      // Written once, whatever closed the dialog. The save is audited on the server.
      void Promise.resolve(patchMisc({ whats_new_seen: latest })).then((saved) => {
        if (saved) return;
        try {
          window.localStorage.setItem(seenMirrorKey(username), latest);
        } catch {
          /* storage blocked: the dialog may show again in this browser */
        }
      });
    },
    [latest, marker, navigate, patchMisc, username],
  );

  if (!plan) return null;
  return (
    <WhatsNewDialog
      open={open}
      plan={plan}
      runningVersion={release.version}
      channelLabel={release.channelLabel}
      canOpen={(page): page is PageId => pageOpenable(page, hasPermission)}
      onClose={close}
    />
  );
}
