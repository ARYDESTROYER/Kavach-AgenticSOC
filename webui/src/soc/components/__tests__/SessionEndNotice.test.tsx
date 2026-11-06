/**
 * Round 14 SPEC §4.1 (ask 1): the automatic sign-out notice says why a session ended
 * and never how long it lasted.
 *
 *  - `signedOutNotice` follows the one wording table of §4.1.1: a time limit (standard
 *    or remembered) and any reason this console does not know get the neutral
 *    sentence; idle, revoked and signed-out-everywhere keep their reasons; no reason,
 *    no notice.
 *  - Regression: for every reason and every lifetime the server or an older device
 *    marker could carry, the rendered notice contains no digit and no unit of time.
 *  - The device marker is written as `{ until }` only; a marker the previous build wrote
 *    as `{ until, lifetime }` still produces the neutral notice, exactly once.
 *  - The notice stays a polite live region linked to the focused field.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import {
  afterSignIn,
  recordSignIn,
  REMEMBERED_UNTIL_KEY,
  REMEMBERED_USERNAME_KEY,
  SIGNED_OUT_NOTICE,
  signedOutNotice,
  takeExpiredRememberedSession,
} from '@/soc/components/auth/rememberMe';
import { SESSION_END_NOTICE_ID, SessionEndNotice } from '@/soc/components/auth/RememberMeControls';
import type { LoginResult } from '@/lib/types';

const NEUTRAL = 'For your security, you were signed out. Sign in to continue.';
const IDLE = 'For your security, you were signed out after a period of inactivity. Sign in to continue.';
const REVOKED = 'This session was ended from another device or by an administrator. Sign in to continue.';
const EVERYWHERE = 'All of your sessions were signed out. Sign in to continue.';

const REASONS = ['absolute_expired', 'idle_expired', 'revoked', 'tv_mismatch', 'future_reason', ''] as const;
const LIFETIMES = [0, 60, 3600, 21_600, 86_400, 604_800] as const;

/** A digit or any unit of time: the notice must never state a duration. */
const DURATION = /\d|\b(hours?|minutes?|days?|weeks?)\b/i;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('signedOutNotice: the wording table (SPEC §4.1.1)', () => {
  it.each([
    ['absolute_expired', NEUTRAL],
    ['idle_expired', IDLE],
    ['revoked', REVOKED],
    ['tv_mismatch', EVERYWHERE],
    ['future_reason', NEUTRAL],
    ['session_rotated', NEUTRAL],
  ])('%s', (reason, copy) => {
    expect(signedOutNotice(reason)).toBe(copy);
  });

  it('shows no notice without a reason', () => {
    expect(signedOutNotice('')).toBeNull();
    expect(signedOutNotice('   ')).toBeNull();
    expect(signedOutNotice(null)).toBeNull();
    expect(signedOutNotice(undefined)).toBeNull();
  });

  it('exports the neutral sentence the table uses', () => {
    expect(SIGNED_OUT_NOTICE).toBe(NEUTRAL);
  });

  it('ignores a duration an older caller still passes', () => {
    // The second parameter is gone; a stray argument from an old call site changes nothing.
    const legacy = signedOutNotice as unknown as (reason: string, lifetime: number) => string | null;
    for (const lifetime of LIFETIMES) {
      expect(legacy('absolute_expired', lifetime)).toBe(NEUTRAL);
    }
  });

  it('keeps every notice in plain copy (no dashes as punctuation, no retired words)', () => {
    for (const reason of REASONS) {
      const text = signedOutNotice(reason) ?? '';
      expect(text).not.toMatch(/[\u2013\u2014]/);
      expect(text.toLowerCase()).not.toContain('playbook');
    }
  });
});

describe('the rendered notice never states a duration (regression)', () => {
  for (const reason of REASONS) {
    for (const lifetime of LIFETIMES) {
      it(`reason "${reason || '(none)'}", lifetime ${lifetime} s`, async () => {
        // A remembered session that ran out while the browser was closed, with a marker
        // the previous build wrote (it carried the length).
        window.localStorage.setItem(REMEMBERED_USERNAME_KEY, 'alice');
        window.localStorage.setItem(
          REMEMBERED_UNTIL_KEY,
          JSON.stringify({ until: Date.now() - 1_000, lifetime }),
        );
        const view = render(<SessionEndNotice reason={reason} />);
        const region = view.container.querySelector('[data-login-notice-region]');
        // The server's reason first; with none, the expired marker on this device.
        const expected = signedOutNotice(reason) ?? NEUTRAL;
        await waitFor(() => expect(region).toHaveTextContent(expected));
        expect(region?.textContent ?? '').not.toMatch(DURATION);
        // The marker is consumed either way, so the notice shows once.
        expect(window.localStorage.getItem(REMEMBERED_UNTIL_KEY)).toBeNull();
      });
    }
  }

  it('shows nothing without a reason and without an expired marker', async () => {
    const onShownChange = vi.fn();
    const view = render(<SessionEndNotice reason="" onShownChange={onShownChange} />);
    await waitFor(() => expect(onShownChange).toHaveBeenCalledWith(false));
    expect(view.container.querySelector('[data-login-notice]')).toBeNull();
  });

  it('shows nothing for an expired marker when no username is remembered', async () => {
    window.localStorage.setItem(REMEMBERED_UNTIL_KEY, JSON.stringify({ until: Date.now() - 1_000 }));
    const view = render(<SessionEndNotice reason={null} />);
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED_UNTIL_KEY)).toBeNull());
    expect(view.container.querySelector('[data-login-notice]')).toBeNull();
  });

  it('stays a polite live region the focused field can point at', async () => {
    const onShownChange = vi.fn();
    const view = render(<SessionEndNotice reason="absolute_expired" onShownChange={onShownChange} />);
    const region = view.container.querySelector('[data-login-notice-region]');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(onShownChange).toHaveBeenLastCalledWith(true));
    expect(document.getElementById(SESSION_END_NOTICE_ID)).toHaveTextContent(NEUTRAL);
    expect(screen.getByText(NEUTRAL)).toBeInTheDocument();
  });
});

describe('the remembered-until marker', () => {
  it('is written as { until } only', () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    recordSignIn('alice', true, { expiresAt });
    const stored = JSON.parse(window.localStorage.getItem(REMEMBERED_UNTIL_KEY) ?? 'null');
    expect(stored).toEqual({ until: Date.parse(expiresAt) });
  });

  it('is written as { until } only by a successful remembered sign-in', () => {
    const expiresAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
    afterSignIn(
      { token: 't', user: { username: 'alice' }, remembered: true, session_expires_at: expiresAt } as LoginResult,
      { username: 'alice', requested: true },
    );
    const raw = window.localStorage.getItem(REMEMBERED_UNTIL_KEY) ?? '';
    expect(JSON.parse(raw)).toEqual({ until: Date.parse(expiresAt) });
    expect(raw).not.toContain('lifetime');
  });

  it('reads a marker the previous build wrote, ignores its lifetime and reports it once', () => {
    const now = Date.now();
    window.localStorage.setItem(REMEMBERED_UNTIL_KEY, JSON.stringify({ until: now - 1, lifetime: 86_400 }));
    expect(takeExpiredRememberedSession(now)).toEqual({ expired: true });
    expect(takeExpiredRememberedSession(now)).toBeNull();
  });

  it('keeps a marker whose session has not ended yet', () => {
    const now = Date.now();
    window.localStorage.setItem(REMEMBERED_UNTIL_KEY, JSON.stringify({ until: now + 60_000 }));
    expect(takeExpiredRememberedSession(now)).toBeNull();
    expect(window.localStorage.getItem(REMEMBERED_UNTIL_KEY)).not.toBeNull();
  });

  it.each(['not json', 'null', '{}', '{"until":"soon"}'])('drops an unreadable marker (%s)', (raw) => {
    window.localStorage.setItem(REMEMBERED_UNTIL_KEY, raw);
    expect(takeExpiredRememberedSession()).toBeNull();
    expect(window.localStorage.getItem(REMEMBERED_UNTIL_KEY)).toBeNull();
  });
});
