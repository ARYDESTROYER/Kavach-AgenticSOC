/**
 * Round 15 (SPEC D5.12): the case Files kit, mounted in the Collaboration tab's Files
 * section (WP7; `heading="section"` below). The
 * gallery lists screenshots with caption, uploader and time; the lightbox always has a
 * DialogTitle (the caption, else a visually hidden "Screenshot N of M"); delete is for
 * the uploader or a moderator behind a confirmation; every object URL is revoked; and
 * nothing writes to the console (`npm run test:strict` requires zero stderr).
 */
import type * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import type { CaseFileEntry, CaseFileList } from '@/lib/types-case-files';

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn(() => true) }));
vi.mock('@/lib/download-blob', () => ({ downloadBlob: downloadBlobMock }));

import { CaseFiles, formatFileSize, screenshotTitle } from '../CaseFiles';

expect.extend(toHaveNoViolations);

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
  has_thumbnail: true,
  deleted: false,
  can_delete: false,
  ...over,
});

const listing = (files: CaseFileEntry[], over: Partial<CaseFileList> = {}): CaseFileList => ({
  case_id: 'case-1',
  files,
  deleted: [],
  count: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0),
  can_upload: false,
  limits: {
    max_files: 20,
    max_case_bytes: 20 * 1024 * 1024,
    max_file_bytes: 2 * 1024 * 1024,
    max_thumbnail_bytes: 48 * 1024,
    max_side_px: 8192,
    max_pixels: 40_000_000,
    max_caption_chars: 200,
    max_filename_chars: 120,
    accepted_types: ['image/jpeg', 'image/png', 'image/webp'],
  },
  ...over,
});

let created: string[] = [];
let revoked: string[] = [];
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  created = [];
  revoked = [];
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${created.length + 1}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
  errorSpy = vi.spyOn(console, 'error');
  warnSpy = vi.spyOn(console, 'warn');
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  expect(errorSpy).not.toHaveBeenCalled();
  expect(warnSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

function apiFor(files: CaseFileEntry[], over: Partial<CaseFileList> = {}) {
  let current = listing(files, over);
  const list = vi.fn(async () => current);
  const remove = vi.fn(async (_case: string, id: string) => {
    const gone = current.files.find((f) => f.id === id)!;
    current = listing(current.files.filter((f) => f.id !== id), over);
    return { file: { ...gone, deleted: true }, deleted: true };
  });
  const fetchBlob = vi.fn(async (_case: string, id: string, options?: { variant?: string; download?: boolean }) => ({
    blob: new Blob([id], { type: 'image/png' }),
    filename: options?.download ? `SOC-0042-${id}.png` : 'screenshot',
  }));
  return { list, remove, fetchBlob };
}

describe('formatting', () => {
  it('writes sizes and titles in plain words', () => {
    expect(formatFileSize(812 * 1024)).toBe('812 KB');
    expect(formatFileSize(1.44 * 1024 * 1024)).toBe('1.4 MB');
    expect(formatFileSize(10)).toBe('1 KB');
    expect(screenshotTitle(entry('a', { caption: 'Login page' }), 0, 2)).toBe('Login page');
    expect(screenshotTitle(entry('b'), 1, 2)).toBe('Screenshot 2 of 2');
  });
});

describe('CaseFiles', () => {
  it('lists screenshots with caption, uploader and a thumbnail', async () => {
    const api = apiFor([entry('f1', { caption: 'Login page' }), entry('f2', { uploaded_by: 'bob' })]);
    render(<CaseFiles caseId="case-1" api={api} />);
    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(screen.getByText('2 of 20')).toBeInTheDocument();
    expect(screen.getByText('f2.png')).toBeInTheDocument();
    expect(screen.getByText(/^bob ·/)).toBeInTheDocument();
    await waitFor(() => expect(api.fetchBlob).toHaveBeenCalledTimes(2));
    expect(api.fetchBlob.mock.calls.map((c) => c[2]?.variant)).toEqual(['thumb', 'thumb']);
    await waitFor(() => expect(created).toHaveLength(2));
  });

  it('opens a lightbox titled by the caption, else a hidden "Screenshot N of M"', async () => {
    const api = apiFor([entry('f1', { caption: 'Login page' }), entry('f2')]);
    render(<CaseFiles caseId="case-1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Login page' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Login page' })).not.toHaveClass('sr-only');
    expect(within(dialog).getByText(/1 of 2 · Added by alice/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('img', { name: 'Login page' })).toBeInTheDocument());
    expect(api.fetchBlob.mock.calls.some((c) => c[1] === 'f1' && c[2]?.variant === 'full')).toBe(true);

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    const title = await within(dialog).findByRole('heading', { name: 'Screenshot 2 of 2' });
    expect(title).toHaveClass('sr-only');
    fireEvent.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByRole('heading', { name: 'Login page' })).toBeInTheDocument();
  });

  it('gives focus back to the thumbnail of the screenshot it showed last when it closes', async () => {
    // The lightbox opens from a thumbnail, not a DialogTrigger, so Radix alone would leave
    // focus on the page body when it closes (WCAG 2.4.3).
    const api = apiFor([entry('f1', { caption: 'Login page' }), entry('f2', { caption: 'Error page' })]);
    render(<CaseFiles caseId="case-1" api={api} />);
    const first = await screen.findByRole('button', { name: 'Open Login page' });
    first.focus();
    fireEvent.click(first);
    let dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(first).toHaveFocus());

    // Stepped to the second screenshot: Close returns to that one's thumbnail.
    fireEvent.click(first);
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Next/ }));
    await within(dialog).findByRole('heading', { name: 'Error page' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Error page' })).toHaveFocus());
  });

  it('downloads through the shared saver with the server file name', async () => {
    const api = apiFor([entry('f1', { caption: 'Login page' })]);
    render(<CaseFiles caseId="case-1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Login page' }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Download/ }));
    });
    expect(api.fetchBlob).toHaveBeenCalledWith('case-1', 'f1', { download: true });
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0][0]).toBe('SOC-0042-f1.png');
  });

  it('offers Delete only where the caller may, behind a confirmation', async () => {
    const api = apiFor([entry('mine', { caption: 'Mine', can_delete: true }), entry('theirs', { caption: 'Theirs' })]);
    render(<CaseFiles caseId="case-1" api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Theirs' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Open Mine' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Delete/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Delete this screenshot?')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete screenshot' }));
    });
    expect(api.remove).toHaveBeenCalledWith('case-1', 'mine');
    await waitFor(() => expect(screen.queryByText('Mine')).toBeNull());
    expect(screen.getByText('Theirs')).toBeInTheDocument();
    // The screenshot and the lightbox are gone, so focus lands on the section heading
    // rather than the page body (WCAG 2.4.3).
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Screenshots' })).toHaveFocus());
  });

  it('decodes only thumbnails in the grid; a screenshot without one waits for the lightbox', async () => {
    const api = apiFor([entry('small', { caption: 'Small' }), entry('big', { caption: 'Big', has_thumbnail: false })]);
    render(<CaseFiles caseId="case-1" api={api} />);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(api.fetchBlob.mock.calls.map((c) => [c[1], c[2]?.variant])).toEqual([['small', 'thumb']]);
    const tile = screen.getByRole('button', { name: 'Open Big' });
    expect(within(tile).getByText('No preview')).toBeInTheDocument();
    fireEvent.click(tile);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('img', { name: 'Big' })).toBeInTheDocument());
    expect(api.fetchBlob.mock.calls.some((c) => c[1] === 'big' && c[2]?.variant === 'full')).toBe(true);
  });

  it('keeps its upload status region in the page before the first status', async () => {
    const api = apiFor([], { can_upload: true });
    render(<CaseFiles caseId="case-1" api={api} />);
    await screen.findByRole('button', { name: 'Add screenshots' });
    const region = screen.getByTestId('case-files-status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('revokes every object URL it made', async () => {
    const api = apiFor([entry('f1'), entry('f2')]);
    const { unmount } = render(<CaseFiles caseId="case-1" api={api} />);
    await waitFor(() => expect(created).toHaveLength(2));
    unmount();
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it('shows the upload zone to someone who can add screenshots, and a full case says so', async () => {
    const api = apiFor([entry('f1')], { can_upload: true });
    const { unmount } = render(<CaseFiles caseId="case-1" api={api} />);
    expect(await screen.findByRole('button', { name: 'Add screenshots' })).toBeEnabled();
    expect(screen.getByLabelText('Caption for the next screenshots (optional)')).toBeInTheDocument();
    unmount();

    const fullApi = apiFor([entry('f1')], {
      can_upload: true,
      limits: { ...listing([]).limits, max_files: 1 },
    });
    render(<CaseFiles caseId="case-1" api={fullApi} />);
    expect(await screen.findByRole('button', { name: 'Add screenshots' })).toBeDisabled();
    expect(screen.getByText('This case has reached its screenshot limit. Delete one to add another.')).toBeInTheDocument();
  });

  it('says there are none to a reader, and offers a retry when loading fails', async () => {
    const api = apiFor([]);
    const { unmount } = render(<CaseFiles caseId="case-1" api={api} />);
    expect(await screen.findByText('No screenshots on this case.')).toBeInTheDocument();
    unmount();

    const list = vi.fn().mockRejectedValueOnce(new Error('Screenshots are temporarily unavailable.'))
      .mockResolvedValueOnce(listing([]));
    render(<CaseFiles caseId="case-1" api={{ ...api, list }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Screenshots are temporarily unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No screenshots on this case.')).toBeInTheDocument();
  });

  it('uploads dropped files with the caption and refreshes the list', async () => {
    const api = apiFor([], { can_upload: true });
    const upload = vi.fn(async () => ({ file: entry('new', { caption: 'Fresh' }), deduplicated: false }));
    const prepare = vi.fn(async () => ({
      image: { blob: new Blob(['x'], { type: 'image/png' }), type: 'image/png', width: 4, height: 3 },
      thumbnail: null,
    }));
    render(<CaseFiles caseId="case-1" api={api} uploadOptions={{ upload, prepare, toBase64: async () => 'eA==' }} />);
    fireEvent.change(await screen.findByLabelText('Caption for the next screenshots (optional)'), {
      target: { value: 'Fresh' },
    });
    const zone = screen.getByTestId('file-drop-zone');
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [new File([new Uint8Array(3)], 'a.png', { type: 'image/png' })], items: [] },
      });
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][1]).toMatchObject({ caption: 'Fresh', filename: 'a.png' });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    // The finished upload leaves the visible list but is still announced.
    const status = screen.getByTestId('case-files-status');
    const done = await within(status).findByText('a.png: added to the case');
    expect(done).toHaveClass('sr-only');
  });

  it('has no accessibility violations', async () => {
    const api = apiFor([entry('f1', { caption: 'Login page' })], { can_upload: true });
    const { container } = render(<CaseFiles caseId="case-1" api={api} />);
    await screen.findByText('Login page');
    await waitFor(() => expect(created).toHaveLength(1));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('CaseFiles under a host section heading (Round 15 WP7: the Collaboration Files section)', () => {
  /** The Collaboration tab's Files section, as `PanelSection` renders it. */
  function Host({ children }: { children: React.ReactNode }) {
    return (
      <section data-section="files" aria-labelledby="files-heading">
        <h2 id="files-heading" data-section-title="" tabIndex={-1}>
          Files
        </h2>
        {children}
      </section>
    );
  }

  it('renders no heading of its own and reports its count and limit to the host', async () => {
    const api = apiFor([entry('f1', { caption: 'Login page' }), entry('f2')]);
    const onCountChange = vi.fn();
    render(
      <Host>
        <CaseFiles caseId="case-1" api={api} heading="section" onCountChange={onCountChange} />
      </Host>,
    );
    expect(await screen.findByText('Login page')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Screenshots' })).toBeNull();
    expect(screen.queryByText('2 of 20')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Screenshots' })).toBeNull();
    await waitFor(() => expect(onCountChange).toHaveBeenLastCalledWith(2, 20));
    await waitFor(() => expect(created).toHaveLength(2));
  });

  it("returns focus to the host's section heading after a delete", async () => {
    const api = apiFor([entry('mine', { caption: 'Mine', can_delete: true })]);
    render(
      <Host>
        <CaseFiles caseId="case-1" api={api} heading="section" />
      </Host>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open Mine' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Delete/ }));
    const confirm = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete screenshot' }));
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Files' })).toHaveFocus());
  });

  it('turns a client that throws at once into a load error, never a broken tree', async () => {
    const list = vi.fn(() => {
      throw new Error('The client is not available.');
    });
    render(<CaseFiles caseId="case-1" api={{ ...apiFor([]), list }} heading="section" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The client is not available.');
  });

  it('makes its drop zone compact once the case has screenshots', async () => {
    const api = apiFor([entry('f1', { caption: 'Login page' })], { can_upload: true });
    render(<CaseFiles caseId="case-1" api={api} heading="section" />);
    await screen.findByText('Login page');
    expect(screen.getByTestId('file-drop-zone')).not.toHaveClass('flex-col');
    await waitFor(() => expect(created).toHaveLength(1));
  });
});
