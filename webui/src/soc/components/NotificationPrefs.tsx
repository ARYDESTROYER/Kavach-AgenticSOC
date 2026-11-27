/**
 * NotificationPrefs — the per-user delivery-preferences panel for the Inbox page
 * (Group 6 / Feature 8 / Round 3 Wave 2).
 *
 * Edits the CURRENT user's `NotificationPref` (GET/PUT /api/notifications/prefs;
 * self-scoped server-side — a user can only ever write their own bucket). It is a
 * per-category × per-channel routing matrix (the IN-APP inbox is ALWAYS on and is
 * therefore shown as a fixed, disabled column), plus a per-category mute toggle,
 * quiet-hours, and a digest cadence.
 *
 * Security: every label here is fixed UI copy (no untrusted data flows through the
 * prefs surface). No secrets are read or written (#10). The prefs are advisory —
 * they govern fan-out only and NEVER feed the deterministic `decide()` (#3).
 */
import * as React from 'react';
import { BellRing, Check, Clock, Loader2, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/cn';
import {
  inboxApi,
  CATEGORY_META,
  DIGEST_OPTIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type CategoryPref,
  type NotificationPrefs as Prefs,
  type QuietHours,
} from '@/soc/pages/Inbox.api';
import { humanizeToken } from '@/lib/format';

import { Button } from '@/ui/button';
import { Switch } from '@/ui/switch';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Skeleton } from '@/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

/* ---------------------------------------------------------------- helpers --- */

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** A category label (known → friendly; unknown → humanised token, never raw). */
function categoryLabel(cat: string): string {
  return CATEGORY_META[cat]?.label ?? humanizeToken(cat);
}
function categoryBlurb(cat: string): string {
  return CATEGORY_META[cat]?.blurb ?? '';
}

/** Deep-ish equality good enough for the dirty check (small JSON-shaped objects). */
function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

/** Normalise a fetched/blank prefs object into a complete, editable shape. */
function normalize(p: Prefs | null): Prefs {
  return {
    user: p?.user,
    categories: { ...(p?.categories ?? {}) },
    quiet_hours: p?.quiet_hours ?? null,
    digest: p?.digest ?? 'off',
  };
}

/** Read one category's pref (absent → enabled, no extra channels). */
function catPref(prefs: Prefs, cat: string): CategoryPref {
  const c = prefs.categories[cat];
  return {
    enabled: c?.enabled ?? true,
    channels: Array.isArray(c?.channels) ? c!.channels! : [],
  };
}

/* ----------------------------------------------------------------- panel ---- */

export interface NotificationPrefsProps {
  className?: string;
  /** Called after a successful save (e.g. so the host can re-read the inbox). */
  onSaved?: () => void;
}

export function NotificationPrefs({ className, onSaved }: NotificationPrefsProps) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);
  // `saved` is the last-persisted snapshot; `draft` is the editable copy.
  const [saved, setSaved] = React.useState<Prefs | null>(null);
  const [draft, setDraft] = React.useState<Prefs | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await inboxApi.getPrefs();
      const norm = normalize(res);
      setSaved(norm);
      setDraft(normalize(res));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = React.useMemo(
    () => Boolean(draft && saved && !sameJson(draft, saved)),
    [draft, saved],
  );

  /* ---- mutators (operate on the draft only) ---- */

  const setCategory = React.useCallback((cat: string, patch: Partial<CategoryPref>) => {
    setDraft((d) => {
      if (!d) return d;
      const current = catPref(d, cat);
      return {
        ...d,
        categories: { ...d.categories, [cat]: { ...current, ...patch } },
      };
    });
  }, []);

  const toggleChannel = React.useCallback(
    (cat: string, channel: string, on: boolean) => {
      setDraft((d) => {
        if (!d) return d;
        const current = catPref(d, cat);
        const set = new Set(current.channels ?? []);
        if (on) set.add(channel);
        else set.delete(channel);
        return {
          ...d,
          categories: {
            ...d.categories,
            [cat]: { ...current, channels: Array.from(set) },
          },
        };
      });
    },
    [],
  );

  const setQuietHours = React.useCallback((patch: Partial<QuietHours> | null) => {
    setDraft((d) => {
      if (!d) return d;
      if (patch === null) return { ...d, quiet_hours: null };
      return { ...d, quiet_hours: { ...(d.quiet_hours ?? {}), ...patch } };
    });
  }, []);

  const setDigest = React.useCallback((value: string) => {
    setDraft((d) => (d ? { ...d, digest: value } : d));
  }, []);

  const save = React.useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await inboxApi.putPrefs({
        categories: draft.categories,
        quiet_hours: draft.quiet_hours ?? null,
        digest: draft.digest ?? 'off',
      });
      const norm = normalize(res);
      setSaved(norm);
      setDraft(normalize(res));
      toast.success('Notification preferences saved.');
      onSaved?.();
    } catch (e) {
      toast.error(errMsg(e, 'Could not save preferences.'));
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  const discard = React.useCallback(() => {
    if (saved) setDraft(normalize(saved));
  }, [saved]);

  /* ---- render ---- */

  if (loading) {
    return (
      <div className={cn('space-y-3', className)}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error || !draft) {
    return (
      <Alert variant="destructive" className={className}>
        <BellRing aria-hidden />
        <AlertTitle>Could not load notification preferences</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          <span>{errMsg(error, 'Request failed.')}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RotateCcw className="size-3.5" aria-hidden />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const quiet = draft.quiet_hours;
  // Quiet-hours on/off is the EXPLICIT presence of the object (the toggle sets it to a
  // window or to null), NOT whether a time string is non-empty — deriving it from the
  // times tore the editor down + flipped the switch off the moment BOTH fields were
  // cleared (e.g. to retype the window).
  const quietOn = quiet != null;

  return (
    <div className={cn('space-y-6', className)}>
      <div className="space-y-1">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose how each kind of notification reaches you. The in-app inbox always
          records every event; the extra channels below are delivered in addition to
          it (and only when that channel is configured by an administrator).
        </p>
      </div>

      {/* ---- per-category × per-channel matrix ---- */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm" aria-label="Notification routing matrix">
          <thead>
            <tr className="border-b border-border bg-surface text-left">
              <th scope="col" className="px-4 py-2.5 font-semibold text-foreground">
                Category
              </th>
              <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-center font-semibold text-foreground">
                In-app
              </th>
              {NOTIFICATION_CHANNELS.map((ch) => (
                <th
                  key={ch.id}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2.5 text-center font-semibold text-foreground"
                >
                  {ch.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_CATEGORIES.map((cat) => {
              const pref = catPref(draft, cat);
              const enabled = pref.enabled ?? true;
              const channels = new Set(pref.channels ?? []);
              return (
                <tr key={cat} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-start gap-2.5">
                      <Switch
                        checked={enabled}
                        onCheckedChange={(v) => setCategory(cat, { enabled: v })}
                        aria-label={`Enable ${categoryLabel(cat)} notifications`}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p
                          className={cn(
                            'font-medium',
                            enabled ? 'text-foreground' : 'text-muted-foreground line-through',
                          )}
                        >
                          {categoryLabel(cat)}
                        </p>
                        {categoryBlurb(cat) ? (
                          <p className="text-xs text-muted-foreground">{categoryBlurb(cat)}</p>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  {/* In-app: always on, never editable. */}
                  <td className="px-3 py-3 text-center align-middle">
                    <span
                      className="inline-flex size-6 items-center justify-center rounded-full bg-success/10 text-success"
                      title="The in-app inbox always records this category"
                      aria-label="In-app always on"
                    >
                      <Check className="size-3.5" aria-hidden />
                    </span>
                  </td>
                  {NOTIFICATION_CHANNELS.map((ch) => (
                    <td key={ch.id} className="px-3 py-3 text-center align-middle">
                      <Switch
                        checked={channels.has(ch.id)}
                        disabled={!enabled}
                        onCheckedChange={(v) => toggleChannel(cat, ch.id, v)}
                        aria-label={`Send ${categoryLabel(cat)} to ${ch.label}`}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        A channel toggle has no effect until that channel is configured under Settings
        → Alerting &amp; Notifications.
      </p>

      <Separator />

      {/* ---- quiet hours ---- */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium text-foreground">Quiet hours</p>
              <p className="text-xs text-muted-foreground">
                Hold non-urgent channel delivery during a daily window (the in-app inbox
                still records everything).
              </p>
            </div>
          </div>
          <Switch
            checked={quietOn}
            onCheckedChange={(v) =>
              v ? setQuietHours({ start: '22:00', end: '07:00' }) : setQuietHours(null)
            }
            aria-label="Enable quiet hours"
          />
        </div>
        {quietOn ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-quiet-start">Start</Label>
              <Input
                id="np-quiet-start"
                type="time"
                value={quiet?.start ?? ''}
                onChange={(e) => setQuietHours({ start: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-quiet-end">End</Label>
              <Input
                id="np-quiet-end"
                type="time"
                value={quiet?.end ?? ''}
                onChange={(e) => setQuietHours({ end: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-quiet-tz">Timezone (optional)</Label>
              <Input
                id="np-quiet-tz"
                placeholder="e.g. America/New_York"
                value={quiet?.tz ?? ''}
                onChange={(e) => setQuietHours({ tz: e.target.value })}
              />
            </div>
          </div>
        ) : null}
      </div>

      <Separator />

      {/* ---- digest cadence ---- */}
      <div className="space-y-1.5">
        <Label htmlFor="np-digest">Digest cadence</Label>
        <Select value={draft.digest ?? 'off'} onValueChange={setDigest}>
          <SelectTrigger id="np-digest" className="w-72" aria-label="Digest cadence">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIGEST_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Batch lower-priority notifications into a single roll-up instead of sending
          each immediately.
        </p>
      </div>

      {/* ---- save bar ---- */}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        {dirty ? (
          <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
            <RotateCcw className="size-4" aria-hidden />
            Discard
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          {saving ? 'Saving…' : 'Save preferences'}
        </Button>
      </div>
    </div>
  );
}

export default NotificationPrefs;
