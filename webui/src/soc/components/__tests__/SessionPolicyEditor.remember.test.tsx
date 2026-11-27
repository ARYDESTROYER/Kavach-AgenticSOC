/**
 * Round 12 — Settings → Security → Session policy: the "Remember me" group
 * (research/remember-me.md §6 web test 11).
 *
 *  - The editor's defaults equal the BACKEND defaults (read from config.py, so the
 *    old 900/1800/43200 drift cannot come back).
 *  - The 6 / 12 / 24 hour presets map to seconds; Custom takes 1–24 hours.
 *  - Enable, inactivity limit, excluded roles and plain-HTTP all round-trip into
 *    `session_policy.remember_me`.
 *  - The editor states what the server enforces: remembered devices never outlast the
 *    absolute lifetime and follow the idle timeout without their own limit; how long
 *    a sign-in without Remember me lasts (AUTH_TOKEN_HOURS); whether this console
 *    refuses Remember me; the plain-HTTP switch only while secure cookies are off.
 *  - The inert access-token TTL lives under Advanced and says it is not enforced.
 *  - No axe violations.
 */
import * as React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

const { setupStatus } = vi.hoisted(() => ({ setupStatus: vi.fn() }));

vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  api: { getSettings: vi.fn(), putSettings: vi.fn(), setup: { status: () => setupStatus() } },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  REMEMBER_ME_DEFAULTS,
  SESSION_POLICY_DEFAULTS,
  SessionPolicyEditor,
  rbacEnabledOf,
} from '../SessionPolicyEditor';
import type { SessionPolicy } from '@/lib/types';
import { api } from '@/lib/api';
import { TooltipProvider } from '@/ui/tooltip';

const CONFIG_PY = readFileSync(
  resolve(__dirname, '../../../../../backend/app/config.py'),
  'utf8',
);

function backendDefault(cls: string, field: string): string {
  const start = CONFIG_PY.indexOf(`class ${cls}(BaseModel):`);
  expect(start).toBeGreaterThan(-1);
  const body = CONFIG_PY.slice(start, CONFIG_PY.indexOf('\nclass ', start + 10));
  const match = new RegExp(`\\n\\s+${field}: [^=\\n]+= (?:Field\\(default=)?([^,)\\n]+)`).exec(body);
  expect(match, `${cls}.${field}`).not.toBeNull();
  return (match as RegExpExecArray)[1].trim();
}

function asNumber(raw: string): number {
  return Number(raw.replace(/_/g, ''));
}

function renderControlled(policy: SessionPolicy = {}, rbacEnabled?: boolean | null) {
  let current: SessionPolicy = policy;
  const ui = () => (
    <TooltipProvider>
      <SessionPolicyEditor policy={current} onChange={onChange} embedded rbacEnabled={rbacEnabled} />
    </TooltipProvider>
  );
  const onChange = vi.fn((next: SessionPolicy) => {
    current = next;
    view.rerender(ui());
  });
  const view = render(ui());
  const last = () => onChange.mock.calls[onChange.mock.calls.length - 1][0] as SessionPolicy;
  return { ...view, onChange, last };
}

function group() {
  return screen.getByRole('group', { name: 'Remember me' });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Unknown runtime by default (the editor then shows every control).
  setupStatus.mockRejectedValue(new Error('offline'));
});

function runtime(remember: Record<string, unknown>) {
  setupStatus.mockResolvedValue({
    remember_me: {
      enabled: true,
      duration_seconds: 86_400,
      insecure_blocked: false,
      secure_cookies: false,
      standard_session_seconds: 12 * 3600,
      ...remember,
    },
  });
}

describe('SessionPolicyEditor — defaults mirror the backend', () => {
  it('matches SessionPolicyConfig and RememberMePolicy defaults', () => {
    expect(SESSION_POLICY_DEFAULTS.access_ttl).toBe(asNumber(backendDefault('SessionPolicyConfig', 'access_ttl')));
    expect(SESSION_POLICY_DEFAULTS.idle_timeout).toBe(asNumber(backendDefault('SessionPolicyConfig', 'idle_timeout')));
    expect(SESSION_POLICY_DEFAULTS.absolute_lifetime).toBe(
      asNumber(backendDefault('SessionPolicyConfig', 'absolute_lifetime')),
    );
    expect(SESSION_POLICY_DEFAULTS.sudo_reauth_window).toBe(
      asNumber(backendDefault('SessionPolicyConfig', 'sudo_reauth_window')),
    );
    expect(REMEMBER_ME_DEFAULTS.duration_seconds).toBe(
      asNumber(backendDefault('RememberMePolicy', 'duration_seconds')),
    );
    expect(String(REMEMBER_ME_DEFAULTS.enabled)).toBe(
      backendDefault('RememberMePolicy', 'enabled').toLowerCase(),
    );
    expect(String(REMEMBER_ME_DEFAULTS.allow_insecure_http)).toBe(
      backendDefault('RememberMePolicy', 'allow_insecure_http').toLowerCase(),
    );
  });

  it('shows the backend defaults for a blank policy', () => {
    renderControlled({});
    // Round 14: the shared NumberField (text input, unit inside), so the value is a string.
    expect(screen.getByLabelText('Idle timeout')).toHaveValue('720'); // 12 h in minutes
    expect(screen.getByLabelText('Absolute lifetime')).toHaveValue('720'); // 30 days in hours
    expect(within(group()).getByRole('radio', { name: '24 hours' })).toBeChecked();
    expect(screen.getByLabelText('Offer “Remember me” on the sign-in page')).toBeChecked();
  });
});

describe('SessionPolicyEditor — Remember me group', () => {
  it('maps the presets to seconds', () => {
    const { last } = renderControlled({});
    fireEvent.click(within(group()).getByRole('radio', { name: '6 hours' }));
    expect(last().remember_me?.duration_seconds).toBe(6 * 3600);
    fireEvent.click(within(group()).getByRole('radio', { name: '12 hours' }));
    expect(last().remember_me?.duration_seconds).toBe(12 * 3600);
    fireEvent.click(within(group()).getByRole('radio', { name: '24 hours' }));
    expect(last().remember_me?.duration_seconds).toBe(24 * 3600);
  });

  it('takes a custom 1–24 hour duration', () => {
    const { last } = renderControlled({});
    fireEvent.click(within(group()).getByRole('radio', { name: 'Custom' }));
    const hours = screen.getByLabelText('Custom duration') as HTMLInputElement;
    expect(hours).toHaveValue('24');
    fireEvent.focus(hours);
    fireEvent.change(hours, { target: { value: '8' } });
    fireEvent.blur(hours);
    expect(last().remember_me?.duration_seconds).toBe(8 * 3600);
    // Clamped to the 24 h maximum.
    fireEvent.focus(hours);
    fireEvent.change(hours, { target: { value: '72' } });
    fireEvent.blur(hours);
    expect(last().remember_me?.duration_seconds).toBe(24 * 3600);
  });

  it('opens on Custom for a stored non-preset duration', () => {
    renderControlled({ remember_me: { duration_seconds: 8 * 3600 } });
    expect(within(group()).getByRole('radio', { name: 'Custom' })).toBeChecked();
    expect(screen.getByLabelText('Custom duration')).toHaveValue('8');
  });

  it('round-trips enable, inactivity, excluded roles and plain HTTP', () => {
    const { last } = renderControlled({});
    fireEvent.click(screen.getByLabelText('Also sign out remembered devices after inactivity'));
    expect(last().remember_me?.idle_seconds).toBe(3600);
    const idle = screen.getByLabelText('Inactivity limit');
    fireEvent.focus(idle);
    fireEvent.change(idle, { target: { value: '30' } });
    fireEvent.blur(idle);
    expect(last().remember_me?.idle_seconds).toBe(1800);
    fireEvent.click(screen.getByLabelText('Also sign out remembered devices after inactivity'));
    expect(last().remember_me?.idle_seconds).toBeNull();

    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Super admin' }));
    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Auditor' }));
    expect(last().remember_me?.excluded_roles).toEqual(['super_admin', 'auditor']);
    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Super admin' }));
    expect(last().remember_me?.excluded_roles).toEqual(['auditor']);

    fireEvent.click(screen.getByLabelText('Allow on plain HTTP (not recommended)'));
    expect(last().remember_me?.allow_insecure_http).toBe(true);

    fireEvent.click(screen.getByLabelText('Offer “Remember me” on the sign-in page'));
    expect(last().remember_me?.enabled).toBe(false);
    // The rest of the group is inert while the feature is off.
    expect(within(group()).getByRole('radio', { name: '6 hours' })).toBeDisabled();
    expect(screen.getByLabelText('Allow on plain HTTP (not recommended)')).toBeDisabled();
    // The standard limits are untouched by the group.
    expect(last().idle_timeout).toBe(SESSION_POLICY_DEFAULTS.idle_timeout);
  });

  it('keeps unknown excluded roles it does not render', () => {
    const { last } = renderControlled({ remember_me: { excluded_roles: ['custom_role'] } });
    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Responder' }));
    expect(last().remember_me?.excluded_roles).toEqual(['responder', 'custom_role']);
  });

  it('has no axe violations', async () => {
    const { container } = renderControlled({});
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SessionPolicyEditor — what the server enforces', () => {
  it('caps remembered devices at the absolute lifetime and says so', () => {
    renderControlled({ absolute_lifetime: 8 * 3600 });
    expect(document.querySelector('[data-remember-capped]')).toHaveTextContent(
      'Remembered devices sign out after 8 hours here, because the absolute lifetime is shorter.',
    );
  });

  it('says remembered devices follow the idle timeout without their own limit', () => {
    const { last } = renderControlled({ idle_timeout: 900 });
    expect(document.querySelector('[data-remember-idle-default]')).toHaveTextContent(
      'When this is off, remembered devices follow the idle timeout (15 minutes without activity).',
    );
    fireEvent.click(screen.getByLabelText('Also sign out remembered devices after inactivity'));
    expect(last().remember_me?.idle_seconds).toBe(3600);
    expect(document.querySelector('[data-remember-idle-default]')).toBeNull();
  });

  it('describes the standard limits without relying on layout', () => {
    renderControlled({});
    expect(screen.getByText(/Remembered devices follow it too/)).toBeInTheDocument();
    expect(screen.getByText(/A remembered device never stays signed in longer than this/))
      .toBeInTheDocument();
    expect(screen.queryByText(/beside it/)).toBeNull();
  });

  it('shows how long a sign-in without Remember me lasts', async () => {
    runtime({ standard_session_seconds: 12 * 3600 });
    renderControlled({});
    expect(await screen.findByText(/also ends after 12 hours/)).toHaveTextContent(
      'A sign-in without “Remember me” also ends after 12 hours (set on the server with AUTH_TOKEN_HOURS), or when the browser closes.',
    );
  });

  it('keeps the unenforced access-token lifetime in its own Access tokens group and says so', () => {
    renderControlled({});
    // A group like the others, not a native disclosure between the panels (Round 14).
    const advanced = document.querySelector('[data-session-policy-advanced]') as HTMLElement;
    expect(advanced).toBe(screen.getByRole('group', { name: 'Access tokens' }));
    expect(document.querySelector('details')).toBeNull();
    const ttl = within(advanced).getByLabelText('Access token lifetime');
    expect(ttl).toHaveValue('60');
    expect(within(advanced).getByText(/Not enforced in this version/)).toBeInTheDocument();
    expect(screen.queryByLabelText('API token rotation')).toBeNull();
  });

  it('reads a long duration in a larger unit in its help line', () => {
    renderControlled({ idle_timeout: 43_200, absolute_lifetime: 2_592_000, sudo_reauth_window: 600 });
    // 720 min reads 12 hours, 720 h reads 30 days; 10 min needs no reading.
    expect(screen.getByLabelText('Idle timeout')).toHaveAccessibleDescription(/\(12 hours\)\.$/);
    expect(screen.getByLabelText('Absolute lifetime')).toHaveAccessibleDescription(/\(30 days\)\.$/);
    expect(screen.getByLabelText('Re-authentication window')).not.toHaveAccessibleDescription(/\(/);
  });

  it('keeps a custom duration when its field is emptied (never the 1 hour minimum)', () => {
    const onChange = renderControlled({ remember_me: { duration_seconds: 8 * 3600 } }).onChange;
    const field = screen.getByLabelText('Custom duration') as HTMLInputElement;
    expect(field.value).toBe('8');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    expect(field.value).toBe('8');
  });

  it('hides the plain-HTTP switch while cookies are marked secure', async () => {
    runtime({ secure_cookies: true });
    renderControlled({});
    await screen.findByText(/also ends after 12 hours/);
    expect(screen.queryByLabelText('Allow on plain HTTP (not recommended)')).toBeNull();
    expect(document.querySelector('[data-remember-transport-status]')).toBeNull();
  });

  it('explains why this console cannot use Remember me while secure cookies are off', async () => {
    runtime({ secure_cookies: false, insecure_blocked: true });
    renderControlled({});
    const status = await waitFor(() => {
      const el = document.querySelector('[data-remember-transport-status]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(status).toHaveTextContent(
      "People who open the Console the way you did can't use Remember me yet: the server does not mark its sign-in cookies as secure. Serve the Console over HTTPS and set AUTH_COOKIE_SECURE=true.",
    );
    expect(screen.getByLabelText('Allow on plain HTTP (not recommended)')).toBeInTheDocument();
    // An older server does not say whether the flag was configured: the sentence is
    // true either way and never claims the variable is unset.
    expect(screen.getByText(/Secure cookies are off \(AUTH_COOKIE_SECURE is not set to true\)/))
      .toBeInTheDocument();
  });

  it.each([
    // Tour 3: run-demo and the Compose file set AUTH_COOKIE_SECURE=false explicitly, and
    // the editor still said "is not set".
    [true, 'Secure cookies are off (AUTH_COOKIE_SECURE=false), so Remember me is offered only when the Console is opened directly on the server.'],
    [false, 'Secure cookies are off (AUTH_COOKIE_SECURE is not set, and it defaults to false), so Remember me is offered only when the Console is opened directly on the server.'],
  ])('states the server\'s actual AUTH_COOKIE_SECURE setting (configured: %s)', async (configured, sentence) => {
    runtime({ secure_cookies: false, secure_cookies_configured: configured, insecure_blocked: true });
    renderControlled({});
    expect(await screen.findByText((_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').startsWith(sentence)))
      .toBeInTheDocument();
    expect(screen.queryByText(configured ? /is not set/ : /AUTH_COOKIE_SECURE=false/)).toBeNull();
  });

  it('has no axe violations with the runtime status shown', async () => {
    runtime({ secure_cookies: false, insecure_blocked: true });
    const { container } = renderControlled({ absolute_lifetime: 8 * 3600 });
    await screen.findByText(/also ends after 12 hours/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('SessionPolicyEditor — excluded roles while role-based access is off', () => {
  const NOTE_ALL =
    'Role-based access is off, so every account counts as Super admin. Excluding Super admin turns Remember me off for everyone.';
  const NOTE_EXCLUDED =
    'Role-based access is off, so every account counts as Super admin. While Super admin is excluded, Remember me is off for everyone.';

  it('warns that excluding Super admin covers every account', () => {
    renderControlled({}, false);
    const note = document.querySelector('[data-remember-rbac-note]');
    expect(note).toHaveTextContent(NOTE_ALL);
    expect(note).toHaveClass('text-warning-text');
    // The role list is described by the note, not only placed near it.
    const roles = within(group()).getByRole('group', { name: 'Never remember these roles' });
    expect(roles).toHaveAccessibleDescription(
      `People with these roles stay signed in only until they close the browser. ${NOTE_ALL}`,
    );
  });

  it('says Remember me is off for everyone once Super admin is excluded', () => {
    const { last } = renderControlled({}, false);
    fireEvent.click(within(group()).getByRole('checkbox', { name: 'Super admin' }));
    expect(last().remember_me?.excluded_roles).toEqual(['super_admin']);
    expect(document.querySelector('[data-remember-rbac-note]')).toHaveTextContent(NOTE_EXCLUDED);
  });

  it('says nothing when role-based access is on, unknown, or Remember me is off', () => {
    const on = renderControlled({ remember_me: { excluded_roles: ['super_admin'] } }, true);
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
    on.unmount();
    const unknown = renderControlled({});
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
    unknown.unmount();
    renderControlled({ remember_me: { enabled: false } }, false);
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
  });

  it('reads the setting itself when it loads its own settings', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      prefs: { session_policy: {}, rbac: { enabled: false } },
      configured: {},
    } as never);
    const view = render(
      <TooltipProvider>
        <SessionPolicyEditor />
      </TooltipProvider>,
    );
    expect(await screen.findByText(NOTE_ALL)).toBeInTheDocument();
    view.unmount();
    vi.mocked(api.getSettings).mockResolvedValue({
      prefs: { session_policy: {}, rbac: { enabled: true } },
      configured: {},
    } as never);
    render(
      <TooltipProvider>
        <SessionPolicyEditor />
      </TooltipProvider>,
    );
    await screen.findByRole('group', { name: 'Remember me' });
    expect(document.querySelector('[data-remember-rbac-note]')).toBeNull();
  });

  it('treats a missing rbac block as off (the backend default) and unknown settings as unknown', () => {
    expect(rbacEnabledOf({})).toBe(false);
    expect(rbacEnabledOf({ rbac: { enabled: false } })).toBe(false);
    expect(rbacEnabledOf({ rbac: { enabled: true } })).toBe(true);
    expect(rbacEnabledOf(null)).toBeNull();
    expect(rbacEnabledOf(undefined)).toBeNull();
  });

  it('has no axe violations with the note shown', async () => {
    const { container } = renderControlled({ remember_me: { excluded_roles: ['super_admin'] } }, false);
    expect(await axe(container)).toHaveNoViolations();
  });
});
