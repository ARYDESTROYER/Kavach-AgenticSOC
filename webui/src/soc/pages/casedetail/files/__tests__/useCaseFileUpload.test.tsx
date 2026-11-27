/**
 * Round 15 (SPEC D4.6, D5.12): the upload hook prepares each file, posts it at once
 * (one at a time), reports each one's progress and failure in plain copy, and never
 * holds a caller up.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ApiError } from '@/lib/api';
import type { CaseFileEntry, CaseFileUploadBody, CaseFileUploadResult } from '@/lib/types-case-files';

import { ScreenshotPrepError } from '../image-encode';
import type { PreparedScreenshot } from '../image-encode';
import { uploadErrorMessage, useCaseFileUpload } from '../useCaseFileUpload';

const entry = (id: string): CaseFileEntry => ({
  id,
  case_id: 'case-1',
  position: 1,
  content_type: 'image/png',
  bytes: 10,
  width: 4,
  height: 3,
  sha256: 'a'.repeat(64),
  caption: '',
  filename: 'shot.png',
  uploaded_by: 'alice',
  uploaded_at: '2026-11-20T10:00:00Z',
  has_thumbnail: true,
  deleted: false,
  can_delete: true,
});

const prepared = (withThumb = true): PreparedScreenshot => ({
  image: { blob: new Blob(['full'], { type: 'image/png' }), type: 'image/png', width: 4, height: 3 },
  thumbnail: withThumb ? { blob: new Blob(['thumb'], { type: 'image/webp' }), type: 'image/webp', width: 2, height: 1 } : null,
});

const file = (name: string) => new File([new Uint8Array(10)], name, { type: 'image/png' });

describe('useCaseFileUpload', () => {
  it('prepares, encodes and posts each file in order', async () => {
    const bodies: CaseFileUploadBody[] = [];
    const upload = vi.fn(async (_case: string, body: CaseFileUploadBody): Promise<CaseFileUploadResult> => {
      bodies.push(body);
      return { file: entry(`f${bodies.length}`), deduplicated: bodies.length === 2 };
    });
    const onUploaded = vi.fn();
    const { result } = renderHook(() =>
      useCaseFileUpload({
        caseId: 'case-1',
        onUploaded,
        prepare: async (f) => prepared(f instanceof File && f.name !== 'b.png'),
        upload,
        toBase64: async (blob) => `b64:${blob.type}`,
      }),
    );
    let added: CaseFileEntry[] = [];
    await act(async () => {
      added = await result.current.uploadFiles([file('a.png'), file('b.png')], '  Login page  ');
    });
    expect(added.map((e) => e.id)).toEqual(['f1', 'f2']);
    expect(bodies).toEqual([
      { data_base64: 'b64:image/png', content_type: 'image/png', thumbnail_base64: 'b64:image/webp', filename: 'a.png', caption: 'Login page' },
      { data_base64: 'b64:image/png', content_type: 'image/png', thumbnail_base64: null, filename: 'b.png', caption: 'Login page' },
    ]);
    expect(upload.mock.calls.map((c) => c[0])).toEqual(['case-1', 'case-1']);
    expect(onUploaded.mock.calls.map((c) => c[1])).toEqual([false, true]);
    expect(result.current.items.map((i) => i.status)).toEqual(['done', 'done']);
    expect(result.current.busy).toBe(false);
  });

  it('records each failure in plain copy and goes on with the next file', async () => {
    const busy = new ApiError(429, 'Too many', { detail: { code: 'case_files_busy', message: 'x' } });
    const upload = vi
      .fn<[string, CaseFileUploadBody], Promise<CaseFileUploadResult>>()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ file: entry('ok'), deduplicated: false });
    const prepare = vi
      .fn<[Blob], Promise<PreparedScreenshot>>()
      .mockRejectedValueOnce(new ScreenshotPrepError('That file is empty.'))
      .mockResolvedValue(prepared());
    const { result } = renderHook(() =>
      useCaseFileUpload({ caseId: 'case-1', prepare, upload, toBase64: async () => 'x' }),
    );
    await act(async () => {
      await result.current.uploadFiles([file('empty.png'), file('busy.png'), file('fine.png')]);
    });
    const items = result.current.items;
    expect(items.map((i) => [i.name, i.status, i.message])).toEqual([
      ['empty.png', 'error', 'That file is empty.'],
      ['busy.png', 'error', 'Too many uploads at once. Try again in a moment.'],
      ['fine.png', 'done', undefined],
    ]);
    act(() => result.current.clearFinished());
    await waitFor(() => expect(result.current.items).toEqual([]));
  });

  it('runs a second batch only after the first has finished', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const prepare = vi.fn(async (f: Blob) => {
      const name = (f as File).name;
      order.push(`prepare:${name}`);
      if (name === 'first.png') await gate;
      return prepared();
    });
    const upload = vi.fn(async (_c: string, body: CaseFileUploadBody) => {
      order.push(`upload:${body.filename}`);
      return { file: entry(body.filename ?? ''), deduplicated: false };
    });
    const { result } = renderHook(() =>
      useCaseFileUpload({ caseId: 'case-1', prepare, upload, toBase64: async () => 'x' }),
    );
    let first: Promise<CaseFileEntry[]> = Promise.resolve([]);
    let second: Promise<CaseFileEntry[]> = Promise.resolve([]);
    act(() => {
      first = result.current.uploadFiles([file('first.png')]);
      second = result.current.uploadFiles([file('second.png')]);
    });
    await waitFor(() => expect(order).toEqual(['prepare:first.png']));
    expect(result.current.items.map((i) => i.status)).toEqual(['preparing', 'queued']);
    await act(async () => {
      release();
      await first;
      await second;
    });
    expect(order).toEqual(['prepare:first.png', 'upload:first.png', 'prepare:second.png', 'upload:second.png']);
  });

  it('names a pasted image that has no file name', async () => {
    const { result } = renderHook(() =>
      useCaseFileUpload({
        caseId: 'case-1',
        prepare: async () => prepared(),
        upload: async () => ({ file: entry('p'), deduplicated: false }),
        toBase64: async () => 'x',
      }),
    );
    await act(async () => {
      await result.current.uploadFiles([new File([new Uint8Array(4)], '', { type: 'image/png' })]);
    });
    expect(result.current.items[0].name).toBe('Pasted image');
  });
});

describe('uploadErrorMessage', () => {
  it('maps the codes a person can act on and falls back to the server text', () => {
    const full = new ApiError(409, 'Server text', { detail: { code: 'case_files_case_full', message: 'Server text' } });
    expect(uploadErrorMessage(full)).toBe('This case has reached its screenshot limit. Delete one to add another.');
    const other = new ApiError(415, 'Only PNG, JPEG and WebP images are accepted.', {
      detail: { code: 'case_files_unsupported_type', message: 'Only PNG, JPEG and WebP images are accepted.' },
    });
    expect(uploadErrorMessage(other)).toBe('Only PNG, JPEG and WebP images are accepted.');
    expect(uploadErrorMessage(undefined)).toBe('The screenshot could not be added.');
  });
});
