/**
 * Round-6 regression — SessionPolicyEditor duration fields must never persist 0.
 *
 * Clearing a duration input used to commit `0` seconds (Number('') === 0), which the UI
 * then rendered as blank while saving a 0 TTL / idle-timeout — an instant session-expiry
 * lockout. The DurationField now buffers raw text and commits the SAFE DEFAULT on an
 * empty/<=0 value instead of 0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  api: { getSettings: vi.fn(), putSettings: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SessionPolicyEditor } from '../SessionPolicyEditor';
import { api } from '@/lib/api';

const DEFAULT_ACCESS_TTL = 3600; // 1h — mirrors DEFAULTS.access_ttl (the backend default)

beforeEach(() => vi.clearAllMocks());

describe('SessionPolicyEditor DurationField (Round-6)', () => {
  it('commits the safe default (not 0) when the field is cleared', () => {
    const onChange = vi.fn();
    render(
      <SessionPolicyEditor policy={{ access_ttl: 1800 }} onChange={onChange} />,
    );

    const input = screen.getByLabelText('Access token TTL') as HTMLInputElement;
    // Shows 30 (minutes) for the 1800s starting value.
    expect(input.value).toBe('30');

    // Clear the field and blur to commit.
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as { access_ttl?: number };
    // Never 0 — falls back to the generous default.
    expect(last.access_ttl).toBe(DEFAULT_ACCESS_TTL);
    expect(last.access_ttl).not.toBe(0);
  });

  it('commits a valid typed value in the field unit (minutes → seconds)', () => {
    const onChange = vi.fn();
    render(<SessionPolicyEditor policy={{ access_ttl: 900 }} onChange={onChange} />);

    const input = screen.getByLabelText('Access token TTL') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0] as { access_ttl?: number };
    expect(last.access_ttl).toBe(300); // 5 minutes
  });

  it('does not expose editable defaults when the authoritative read fails', async () => {
    vi.mocked(api.getSettings)
      .mockRejectedValueOnce(new Error('settings unavailable'))
      .mockResolvedValueOnce({ prefs: { session_policy: { access_ttl: 1200 } } } as never);

    render(<SessionPolicyEditor />);

    expect(await screen.findByText('Could not load session policy')).toBeInTheDocument();
    expect(screen.queryByLabelText('Access token TTL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByLabelText('Access token TTL')).toHaveValue(20));
  });
});
