/**
 * Round 16 (SPEC §4.5 WP14): two screenshot fixes in the case Files section.
 *
 * * B30: the delete confirmation promises that a deleted screenshot's caption, who added
 *   it and when stay on the case. The Files section now lists the deleted screenshots the
 *   server keeps (`GET /api/cases/{id}/files` `deleted[]`), and the dialog names where.
 * * B31: choosing more screenshots than the case has room for reports every file left
 *   out, instead of dropping it without a word.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { CaseFileEntry, CaseFileList } from '@/lib/types-case-files';

vi.mock('@/lib/download-blob', () => ({ downloadBlob: vi.fn(() => true) }));

import { CaseFiles } from '../CaseFiles';

const entry = (id: string, over: Partial<CaseFileEntry> = {}): CaseFileEntry => ({
  id,
  case_id: 'case-1',
  position: 1,
  content_type: 'image/png',
  bytes: 812 * 1024,
  width: 1920,
  height: 1080,
  sha256: 'a'.repeat(64),
  caption: '',
  filename: `${id}.png`,
  uploaded_by: 'alice',
  uploaded_at: '2026-11-20T10:00:00Z',
  has_thumbnail: false,
  deleted: false,
  can_delete: false,
  ...over,
});

const LIMITS: CaseFileList['limits'] = {
  max_files: 20,
  max_case_bytes: 20 * 1024 * 1024,
  max_file_bytes: 2 * 1024 * 1024,
  max_thumbnail_bytes: 48 * 1024,
  max_side_px: 8192,
  max_pixels: 40_000_000,
  max_caption_chars: 200,
  max_filename_chars: 120,
  accepted_types: ['image/jpeg', 'image/png', 'image/webp'],
};

const listing = (files: CaseFileEntry[], over: Partial<CaseFileList> = {}): CaseFileList => ({
  case_id: 'case-1',
  files,
  deleted: [],
  count: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0),
  can_upload: false,
  limits: LIMITS,
  ...over,
});

function apiOf(value: CaseFileList) {
  return {
    list: vi.fn(async () => value),
    remove: vi.fn(),
    fetchBlob: vi.fn(async () => ({ blob: new Blob(['x'], { type: 'image/png' }), filename: 'x.png' })),
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error');
});
afterEach(() => {
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

describe('B30: a deleted screenshot keeps its caption, who added it and when', () => {
  it('lists the deleted screenshots, folded, with caption or file name and who deleted them', async () => {
    const api = apiOf(
      listing([], {
        deleted: [
          entry('gone1', {
            caption: 'Phishing page',
            deleted: true,
            deleted_by: 'bob',
            deleted_at: '2026-11-21T09:00:00Z',
          }),
          entry('gone2', { filename: 'multi2.png', deleted: true, deleted_by: 'carol' }),
        ],
      }),
    );
    render(<CaseFiles caseId="case-1" api={api} />);
    const toggle = await screen.findByRole('button', { name: /Deleted screenshots \(2\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const list = screen.getByRole('list', { name: 'Deleted screenshots' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Phishing page');
    expect(items[0]).toHaveTextContent('Added by alice');
    expect(items[0]).toHaveTextContent('deleted by bob');
    // No caption: the file name stands in.
    expect(items[1]).toHaveTextContent('multi2.png');
    expect(items[1]).toHaveTextContent('deleted by carol');
  });

  it('renders a hostile caption as text', async () => {
    const api = apiOf(
      listing([], { deleted: [entry('gone', { caption: '<img src=x onerror=alert(1)>', deleted: true })] }),
    );
    render(<CaseFiles caseId="case-1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: /Deleted screenshots \(1\)/ }));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says where the deleted screenshot stays before it deletes it', async () => {
    const api = apiOf(listing([entry('mine', { caption: 'Mine', can_delete: true })]));
    render(<CaseFiles caseId="case-1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Mine' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Delete/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Its caption, who added it and when stay listed under Deleted screenshots.');
  });

  it('shows no deleted list when nothing was deleted', async () => {
    render(<CaseFiles caseId="case-1" api={apiOf(listing([entry('f1', { caption: 'Kept' })]))} />);
    await screen.findByText('Kept');
    expect(screen.queryByRole('button', { name: /Deleted screenshots/ })).toBeNull();
  });
});

describe('B31: files over the room left are reported, not dropped', () => {
  it('uploads what fits and lists each file it left out', async () => {
    const api = apiOf(listing([entry('f1', { caption: 'One' })], { can_upload: true, limits: { ...LIMITS, max_files: 2 } }));
    const upload = vi.fn(async () => ({ file: entry('new'), deduplicated: false }));
    const prepare = vi.fn(async () => ({
      image: { blob: new Blob(['x'], { type: 'image/png' }), type: 'image/png', width: 4, height: 3 },
      thumbnail: null,
    }));
    render(<CaseFiles caseId="case-1" api={api} uploadOptions={{ upload, prepare, toBase64: async () => 'eA==' }} />);
    await screen.findByText('One');
    const files = ['a.png', 'b.png', 'c.png'].map((name) => new File([new Uint8Array(3)], name, { type: 'image/png' }));
    await act(async () => {
      fireEvent.drop(screen.getByTestId('file-drop-zone'), { dataTransfer: { files, items: [] } });
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][1]).toMatchObject({ filename: 'a.png' });
    const status = screen.getByTestId('case-files-status');
    expect(within(status).getByText('b.png: not added. This case allows 2 screenshots.')).toBeInTheDocument();
    expect(within(status).getByText('c.png: not added. This case allows 2 screenshots.')).toBeInTheDocument();
  });
});
