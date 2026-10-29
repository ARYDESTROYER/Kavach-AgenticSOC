/**
 * MfaSetupCard host-started mode (Round 14, SPEC §4.9.6). Settings shows two-factor as one
 * row ("Two-factor authentication · Off · Turn on") whose action mounts the card with
 * `autoStart`. The card must then:
 *   - start enrollment itself when two-factor is off (the session endpoint, never the
 *     login-phase one), or open the turn-off form when it is on;
 *   - render no start or turn-off trigger of its own (the row owns it);
 *   - keep focus off <body> while the setup request runs (the "Preparing" line takes it)
 *     and move it to "Try again" when the start fails;
 *   - move focus to the first step when the enrollment arrives, so reading order runs
 *     through the QR code, secret and one-time recovery codes before the code field;
 *   - draw no rule of its own under the host's row (the row's hairline divides them);
 *   - keep the code field and its submit focusable while the code is checked (read-only,
 *     `aria-disabled`), and hand focus to the field when the check fails;
 *   - hand Cancel back to the host through `onCancel`.
 * It never shows an em dash in what it renders.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { setupMock, confirmMock, disableMock, enrollSetupMock, downloadMock } = vi.hoisted(() => ({
  setupMock: vi.fn(),
  confirmMock: vi.fn(),
  disableMock: vi.fn(),
  enrollSetupMock: vi.fn(),
  downloadMock: vi.fn(() => true),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    api: {
      auth: {
        mfa: {
          setup: setupMock,
          confirm: confirmMock,
          disable: disableMock,
          enrollSetup: enrollSetupMock,
          enrollConfirm: vi.fn(),
        },
      },
    },
  };
});
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/download-blob', () => ({ downloadBlob: downloadMock }));

/** jsdom's Blob has no `text()`: read it the FileReader way. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

import { ApiError } from '@/lib/api';
import { MfaSetupCard } from '../MfaSetupCard';

const SETUP_PAYLOAD = {
  secret: 'HOSTSECRET23456789',
  otpauth_uri: 'otpauth://totp/Agentic%20SOC:ann?secret=HOSTSECRET23456789',
  recovery_codes: ['eeee-5555', 'ffff-6666'],
};

beforeEach(() => {
  setupMock.mockReset();
  confirmMock.mockReset();
  disableMock.mockReset();
  enrollSetupMock.mockReset();
});

/**
 * What a browser does when the focused button becomes disabled: focus falls to <body>.
 * jsdom neither does that nor blurs a disabled element, so a stand-in takes focus and is
 * removed, which leaves <body> focused.
 */
function dropFocusToBody() {
  const standIn = document.createElement('button');
  document.body.appendChild(standIn);
  act(() => standIn.focus());
  act(() => standIn.remove());
  expect(document.activeElement).toBe(document.body);
}

function noDashes() {
  expect(document.body.textContent ?? '').not.toMatch(/[–—]/);
}

describe('MfaSetupCard autoStart (host-started)', () => {
  it('starts enrollment on mount with no trigger of its own, and holds focus while it waits', async () => {
    let resolve: (value: typeof SETUP_PAYLOAD) => void = () => undefined;
    setupMock.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<MfaSetupCard enabled={false} frameless autoStart onCancel={vi.fn()} />);

    expect(setupMock).toHaveBeenCalledTimes(1);
    expect(enrollSetupMock).not.toHaveBeenCalled();
    const preparing = screen.getByRole('status');
    expect(preparing).toHaveTextContent('Preparing your authenticator setup');
    expect(document.activeElement).toBe(preparing);
    expect(screen.queryByRole('button', { name: /turn on two-factor/i })).toBeNull();

    resolve({ ...SETUP_PAYLOAD });
    expect(await screen.findByText('HOSTSECRET23456789')).toBeInTheDocument();
    // The first step takes focus as the enrollment arrives (never the code field at the
    // bottom, which would skip the QR code, the secret and the one-time recovery codes).
    const step = screen.getByText('1. Scan with your authenticator app');
    await waitFor(() => expect(document.activeElement).toBe(step));
    expect(step).toHaveAttribute('tabindex', '-1');
    const code = screen.getByLabelText(/enter the 6-digit code/i);
    expect(code).not.toHaveFocus();
    // Reading order from the focused step: the recovery codes, then the code field.
    const recovery = screen.getByText('eeee-5555');
    expect(step.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recovery.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    noDashes();
  });

  it('draws no rule of its own under the host row', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    const { container } = render(<MfaSetupCard enabled={false} frameless autoStart onCancel={vi.fn()} />);
    await screen.findByText('HOSTSECRET23456789');
    expect(container.querySelector('[data-orientation="horizontal"]')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('keeps focus on the submit while the code is checked, then hands it to the code field', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    let reject: (reason: unknown) => void = () => undefined;
    confirmMock.mockReturnValue(new Promise((_, r) => (reject = r)));
    render(<MfaSetupCard enabled={false} frameless autoStart onChanged={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText('HOSTSECRET23456789');
    const code = screen.getByLabelText(/enter the 6-digit code/i);
    fireEvent.change(code, { target: { value: '123456' } });
    const submit = screen.getByRole('button', { name: 'Verify and turn on' });
    act(() => submit.focus());
    fireEvent.click(submit);
    // Nothing that holds focus is disabled while the request runs: a browser would move
    // focus from it to <body>. The field is read-only and the submit busy.
    expect(code).toHaveAttribute('readonly');
    expect(code).toBeEnabled();
    expect(submit).toBeEnabled();
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(document.activeElement).toBe(submit);
    // A second press while busy does not submit again.
    fireEvent.click(submit);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await act(async () => reject(new ApiError(400, 'That code did not match.')));
    expect(await screen.findByText('That code did not match.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(code).not.toHaveAttribute('readonly');
    expect(submit).not.toHaveAttribute('aria-disabled');
  });

  it('hands focus to the code field even when the browser had dropped it to <body>', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    let reject: (reason: unknown) => void = () => undefined;
    confirmMock.mockReturnValue(new Promise((_, r) => (reject = r)));
    render(<MfaSetupCard enabled={false} frameless autoStart onChanged={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText('HOSTSECRET23456789');
    const code = screen.getByLabelText(/enter the 6-digit code/i);
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and turn on' }));
    dropFocusToBody();
    await act(async () => reject(new ApiError(400, 'That code did not match.')));
    await waitFor(() => expect(document.activeElement).toBe(code));
  });

  it('hands Cancel back to the host', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    const onCancel = vi.fn();
    render(<MfaSetupCard enabled={false} frameless autoStart onCancel={onCancel} />);
    await screen.findByText('HOSTSECRET23456789');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('finishes enrollment through onChanged', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    confirmMock.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<MfaSetupCard enabled={false} frameless autoStart onChanged={onChanged} onCancel={vi.fn()} />);
    await screen.findByText('HOSTSECRET23456789');
    fireEvent.change(screen.getByLabelText(/enter the 6-digit code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and turn on' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledWith('123456');
  });

  it('moves focus to "Try again" when the start fails, and offers Cancel', async () => {
    setupMock.mockRejectedValue(new ApiError(500, 'The setup service is unavailable.'));
    const onCancel = vi.fn();
    render(<MfaSetupCard enabled={false} frameless autoStart onCancel={onCancel} />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText('The setup service is unavailable.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(retry));

    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    fireEvent.click(retry);
    expect(await screen.findByText('HOSTSECRET23456789')).toBeInTheDocument();
    expect(setupMock).toHaveBeenCalledTimes(2);
  });

  it('opens the turn-off form when two-factor is on, with Cancel handed back', async () => {
    disableMock.mockResolvedValue({ ok: true });
    const onCancel = vi.fn();
    const onChanged = vi.fn();
    render(<MfaSetupCard enabled frameless autoStart onCancel={onCancel} onChanged={onChanged} />);
    expect(setupMock).not.toHaveBeenCalled();
    const code = screen.getByLabelText('Enter a current code to turn off two-factor');
    expect(document.activeElement).toBe(code);
    // No second trigger: the host row owns "Turn off".
    expect(screen.getAllByRole('button', { name: /turn off two-factor/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.change(code, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /turn off two-factor/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(disableMock).toHaveBeenCalledWith('654321');
    noDashes();
  });

  it('returns focus to the code field when turning off fails, and says so plainly', async () => {
    disableMock.mockRejectedValue(new Error('network down'));
    render(<MfaSetupCard enabled frameless autoStart onCancel={vi.fn()} onChanged={vi.fn()} />);
    const code = screen.getByLabelText('Enter a current code to turn off two-factor');
    fireEvent.change(code, { target: { value: '654321' } });
    const submit = screen.getByRole('button', { name: /turn off two-factor/i });
    act(() => submit.focus());
    fireEvent.click(submit);
    expect(code).toHaveAttribute('readonly');
    expect(submit).toHaveAttribute('aria-disabled', 'true');
    expect(submit).toBeEnabled();
    // A failure that is not an API error falls back to plain words, never "MFA".
    expect(await screen.findByText('Could not turn off two-factor.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(code));
    noDashes();
  });

  it('leaves focus alone when the operator moved it before the failure', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    disableMock.mockReturnValue(new Promise((_, r) => (reject = r)));
    render(<MfaSetupCard enabled frameless autoStart onCancel={vi.fn()} onChanged={vi.fn()} />);
    const code = screen.getByLabelText('Enter a current code to turn off two-factor');
    fireEvent.change(code, { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /turn off two-factor/i }));
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    act(() => elsewhere.focus());
    await act(async () => reject(new Error('network down')));
    expect(await screen.findByText('Could not turn off two-factor.')).toBeInTheDocument();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('says plainly when the setup cannot start', async () => {
    setupMock.mockRejectedValue(new Error('network down'));
    render(<MfaSetupCard enabled={false} frameless autoStart onCancel={vi.fn()} />);
    expect(await screen.findByText('Could not start two-factor setup.')).toBeInTheDocument();
    noDashes();
  });
});

describe('MfaSetupCard without autoStart (unchanged triggers)', () => {
  it('starts only from its own "Turn on two-factor" and cancels in place', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    render(<MfaSetupCard enabled={false} frameless />);
    expect(setupMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
    await screen.findByText('HOSTSECRET23456789');
    // The trigger it pressed is gone: focus lands on the first step, not the code field.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText('1. Scan with your authenticator app')),
    );
    // Outside a host row the card keeps its own rule above the steps.
    expect(document.querySelector('[data-orientation="horizontal"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('HOSTSECRET23456789')).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on two-factor' })).toBeInTheDocument();
  });

  it('opens and closes its own turn-off form when two-factor is on', () => {
    render(<MfaSetupCard enabled frameless />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off two-factor' }));
    expect(screen.getByLabelText('Enter a current code to turn off two-factor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Enter a current code to turn off two-factor')).toBeNull();
  });

  it('names the downloaded recovery codes file without an em dash', async () => {
    setupMock.mockResolvedValue({ ...SETUP_PAYLOAD });
    downloadMock.mockClear();
    render(<MfaSetupCard enabled={false} frameless />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on two-factor' }));
    await screen.findByText('HOSTSECRET23456789');
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(downloadMock).toHaveBeenCalledTimes(1);
    const [filename, blob] = downloadMock.mock.calls[0] as unknown as [string, Blob];
    expect(filename).toBe('agentic-soc-recovery-codes.txt');
    const text = await blobText(blob);
    expect(text.startsWith('Agentic SOC two-factor recovery codes')).toBe(true);
    expect(text).toContain('eeee-5555');
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
