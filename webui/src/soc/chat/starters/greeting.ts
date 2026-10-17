/**
 * The start screen's greeting (SPEC-chat §5.2): "Good morning", "Good afternoon" or
 * "Good evening" by the browser's local time (05:00 to 11:59, 12:00 to 17:59, otherwise),
 * then ", {first name}" from the signed-in display name (its first word), else the
 * username, else nothing (auth off).
 *
 * The display name comes from `GET /api/account/me`, whose body is
 * `{authenticated, auth_enabled, env_managed, user: {username, display_name, ...}}`
 * (`routes.account_me`): the name is `user.display_name` (a top-level `display_name`
 * is read too, for safety). It is read only when someone is signed in, cached per
 * principal and re-read in the background when a start stack mounts more than a
 * minute after the last read, so a name saved on the Account page reaches the greeting
 * on the next new chat without a reload. Any failure keeps the last known name (or
 * the username). It is the analyst's own text, rendered as React text only.
 */
import * as React from 'react';

import { api } from '@/lib/api';
import { displayText } from '../stream-events';

export function greetingFor(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** The first word of a name, display-sanitised; null when nothing visible is left. */
export function firstWord(value: unknown): string | null {
  const text = displayText(value, 0);
  const word = text.split(/\s+/)[0] ?? '';
  return word ? (Array.from(word).length > 40 ? Array.from(word).slice(0, 40).join('') : word) : null;
}

/** "Good afternoon, Aryan" / "Good afternoon". */
export function greetingLine(name: string | null, date: Date = new Date()): string {
  return name ? `${greetingFor(date)}, ${name}` : greetingFor(date);
}

/** A cached display name older than this is re-read when a start stack mounts. */
export const GREETING_NAME_TTL_MS = 60_000;

/** principal → display name ('' when the profile has none) and when it was read. */
const names = new Map<string, { name: string; at: number }>();
const pending = new Map<string, Promise<string>>();

/** Test hook. */
export function clearGreetingNameCache(): void {
  names.clear();
  pending.clear();
}

/**
 * The display name in a `GET /api/account/me` body: `user.display_name`, else a
 * top-level `display_name`; '' when neither is a string.
 */
export function profileDisplayName(profile: unknown): string {
  if (!profile || typeof profile !== 'object') return '';
  const body = profile as { user?: unknown; display_name?: unknown };
  const user = body.user && typeof body.user === 'object' ? (body.user as { display_name?: unknown }) : null;
  if (user && typeof user.display_name === 'string' && user.display_name.trim()) return user.display_name;
  return typeof body.display_name === 'string' ? body.display_name : '';
}

function readDisplayName(principal: string): Promise<string> {
  let read = pending.get(principal);
  if (!read) {
    read = api.account
      .get()
      .then((profile) => {
        const name = profileDisplayName(profile);
        names.set(principal, { name, at: Date.now() });
        return name;
      })
      .catch(() => {
        // Keep a name already known; a first failure falls back to the username.
        const known = names.get(principal);
        names.set(principal, { name: known?.name ?? '', at: Date.now() });
        return known?.name ?? '';
      })
      .finally(() => pending.delete(principal));
    pending.set(principal, read);
  }
  return read;
}

/**
 * The name the greeting uses for `principal` (the signed-in username, or null when auth
 * is off): the display name's first word once known, else the username's first word.
 */
export function useGreetingName(principal: string | null): string | null {
  const [displayName, setDisplayName] = React.useState<string | null>(() =>
    principal ? (names.get(principal)?.name ?? null) : null,
  );
  React.useEffect(() => {
    if (!principal) {
      setDisplayName(null);
      return undefined;
    }
    let alive = true;
    const cached = names.get(principal);
    setDisplayName(cached ? cached.name : null);
    // Fresh enough: no request. Otherwise show what is known and re-read it.
    if (cached && Date.now() - cached.at < GREETING_NAME_TTL_MS) return undefined;
    void readDisplayName(principal).then((name) => {
      if (alive) setDisplayName(name);
    });
    return () => {
      alive = false;
    };
  }, [principal]);
  if (!principal) return null;
  return firstWord(displayName) ?? firstWord(principal);
}
