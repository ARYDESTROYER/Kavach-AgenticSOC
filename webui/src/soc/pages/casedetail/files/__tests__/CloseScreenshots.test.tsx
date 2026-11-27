/**
 * Round 15 (SPEC D4.6, D5.12; WP7): "Add screenshots" in the close dialog. Each image is
 * uploaded at once (the close never waits for it), a paste anywhere in the dialog adds
 * the pasted image, the host hears of each upload (its Files section re-reads), and a
 * refusal is shown in plain words. Nothing writes to the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { ApiError } from '@/lib/api';
import type { CaseFileEntry } from '@/lib/types-case-files';

import { CloseScreenshots } from '../CloseScreenshots';

const entry = (id: string): CaseFileEntry => ({
  id,
  case_id: 'case-1',
  position: 1,
  content_type: 'image/png',
  bytes: 1024,
  width: 4,
  height: 3,
  sha256: 'b'.repeat(64),
  caption: '',
  filename: `${id}.png`,
  uploaded_by: 'alice',
  uploaded_at: '2026-11-20T10:00:00Z',
  has_thumbnail: false,
  deleted: false,
  can_delete: true,
});

const prepare = vi.fn(async () => ({
  image: { blob: new Blob(['x'], { type: 'image/png' }), type: 'image/png', width: 4, height: 3 },
  thumbnail: null,
}));
const toBase64 = async () => 'eA==';
const png = (name: string) => new File([new Uint8Array(3)], name, { type: 'image/png' });

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error');
  warnSpy = vi.spyOn(console, 'warn');
});
afterEach(() => {
  expect(errorSpy).not.toHaveBeenCalled();
  expect(warnSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('CloseScreenshots', () => {
  it('uploads a dropped image at once and tells the host', async () => {
    const upload = vi.fn(async () => ({ file: entry('f1'), deduplicated: false }));
    const onUploaded = vi.fn();
    render(<CloseScreenshots caseId="case-1" onUploaded={onUploaded} uploadOptions={{ upload, prepare, toBase64 }} />);
    expect(screen.getByRole('button', { name: 'Add screenshots' })).toBeEnabled();
    expect(
      screen.getByText('Drop, paste or choose PNG, JPEG or WebP images. Each is added to the case as soon as it is ready.'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [png('a.png')], items: [] } });
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0]).toBe('case-1');
    expect(upload.mock.calls[0][1]).toMatchObject({ filename: 'a.png', caption: '', content_type: 'image/png' });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' })));
    expect(await screen.findByText('a.png: added to the case')).toBeInTheDocument();
  });

  it('catches a pasted image anywhere in its paste scope (the dialog)', async () => {
    const upload = vi.fn(async () => ({ file: entry('f2'), deduplicated: false }));
    function Dialogish() {
      const scope = React.useRef<HTMLDivElement | null>(null);
      return (
        <div ref={scope} data-testid="scope">
          <textarea aria-label="Analyst note" />
          <CloseScreenshots caseId="case-1" pasteScopeRef={scope} uploadOptions={{ upload, prepare, toBase64 }} />
        </div>
      );
    }
    render(<Dialogish />);
    const note = screen.getByRole('textbox', { name: 'Analyst note' });
    // Text pasted into the note is left alone.
    await act(async () => {
      fireEvent.paste(note, { clipboardData: { files: [], items: [] } });
    });
    expect(upload).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.paste(note, { clipboardData: { files: [png('pasted.png')], items: [] } });
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][1]).toMatchObject({ filename: 'pasted.png' });
  });

  it('says why an upload was refused, in plain words', async () => {
    const upload = vi.fn(async () => {
      throw new ApiError(409, 'full', { detail: { code: 'case_files_case_full', message: 'full' } });
    });
    render(<CloseScreenshots caseId="case-1" uploadOptions={{ upload, prepare, toBase64 }} />);
    await act(async () => {
      fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files: [png('b.png')], items: [] } });
    });
    expect(
      await screen.findByText('b.png: This case has reached its screenshot limit. Delete one to add another.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('close-screenshots-status')).toHaveAttribute('aria-live', 'polite');
  });
});
