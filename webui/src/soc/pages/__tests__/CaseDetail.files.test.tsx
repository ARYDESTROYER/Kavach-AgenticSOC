/**
 * Round 15 (SPEC D4.6, D5.12; WP7): screenshots in the case workspace.
 *
 *   - The Collaboration tab's Files section is the lazy gallery, with the tab as its paste
 *     scope and its count ("1 of 20") beside the heading, never a second heading.
 *   - The case thread's live stream carries the screenshot frames: a `case.activity` frame
 *     that names a `file_id` re-reads the Files section and leaves the thread alone; any
 *     other frame re-reads the thread as before. One stream, no second subscription.
 *   - The close dialog offers "Add screenshots" (the dialog as its paste scope) to a
 *     viewer who holds `cases:comment`, the grant the upload route checks, and not to one
 *     who does not; the server's own `can_upload` and `can_delete` gate the gallery.
 *   - A pasted image anywhere in the Collaboration tab (the thread's composer included)
 *     is added once; with the close dialog open over the tab, the dialog takes it, and
 *     the tab does not add it a second time.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { CaseFileList } from '@/lib/types-case-files';

const env = vi.hoisted(() => ({
  grants: new Set<string>(),
  streams: [] as Array<{ topics: string[]; onEvent?: (ev: { type: string; data: unknown }) => void }>,
  listing: null as unknown,
}));

const OPEN_CASE = {
  case_id: 'c-files-1',
  case_number: 'CASE-0201',
  title: 'Phishing link clicked',
  status: 'open',
  verdict: 'NEEDS_HUMAN',
  confidence: 0.5,
  risk_score: 60,
  severity_band: 'high',
  created_at: '2026-11-23T10:00:00Z',
  updated_at: '2026-11-23T10:05:00Z',
  history: [],
  feedback: [],
  comments: [],
  tags: [],
};

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), warning: vi.fn() } }));

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: (topics: string[], opts: { onEvent?: (ev: { type: string; data: unknown }) => void } = {}) => {
    env.streams.push({ topics, onEvent: opts.onEvent });
    return { live: false };
  },
  STREAM_CHANNELS: ['case.activity'],
}));

vi.mock('@/soc/pages/CaseDetail.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../CaseDetail.api')>();
  return {
    ...actual,
    getTriage: vi.fn().mockResolvedValue({ case_id: 'c-files-1', found: false, chips: null }),
    getThread: vi.fn().mockResolvedValue({ messages: [] }),
    getActivity: vi.fn().mockResolvedValue({ activity: [] }),
    listPickableUsers: vi.fn().mockResolvedValue([]),
  };
});

// The canvas re-encode needs a real browser; the upload path is what these tests read.
vi.mock('@/soc/pages/casedetail/files/image-encode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../casedetail/files/image-encode')>();
  return {
    ...actual,
    prepareScreenshot: vi.fn(async () => ({
      image: { blob: new Blob(['x'], { type: 'image/png' }), type: 'image/png', width: 4, height: 3 },
      thumbnail: null,
    })),
    blobToBase64: vi.fn(async () => 'eA=='),
  };
});

vi.mock('@/lib/api-case-files', () => ({
  listCaseFiles: vi.fn(() => Promise.resolve(env.listing)),
  deleteCaseFile: vi.fn(),
  uploadCaseFile: vi.fn(async (caseId: string, body: { filename: string }) => ({
    file: {
      id: `up-${body.filename}`,
      case_id: caseId,
      position: 1,
      content_type: 'image/png',
      bytes: 1,
      width: 4,
      height: 3,
      sha256: 'd'.repeat(64),
      caption: '',
      filename: body.filename,
      uploaded_by: 't1',
      uploaded_at: '2026-11-23T10:20:00Z',
      has_thumbnail: false,
      deleted: false,
      can_delete: true,
    },
    deduplicated: false,
  })),
  fetchCaseFileBlob: vi.fn(() => Promise.resolve({ blob: new Blob(['x'], { type: 'image/png' }), filename: 'x.png' })),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  const target: Record<string, unknown> = {
    getCase: vi.fn(() => Promise.resolve(OPEN_CASE)),
    getModels: vi.fn(() => Promise.resolve({ providers: {} })),
    getSettings: vi.fn(() => Promise.resolve({ prefs: {}, configured: {}, read_only: false })),
  };
  return {
    ApiError,
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => {
  const has = (resource: string, action: string) => env.grants.has(`${resource}:${action}`);
  return {
    useAuth: () => ({
      username: 't1',
      role: 'analyst_tier1',
      authEnabled: true,
      rbacEnabled: true,
      hasPermission: has,
      user: null,
    }),
    useOptionalAuth: () => ({ hasPermission: has }),
  };
});

import { listCaseFiles, uploadCaseFile } from '@/lib/api-case-files';
import { getThread } from '@/soc/pages/CaseDetail.api';
import { CaseDetail } from '@/soc/pages/CaseDetail';

const listing = (count: number, over: Partial<CaseFileList> = {}): CaseFileList => ({
  case_id: 'c-files-1',
  files: Array.from({ length: count }, (_, i) => ({
    id: `f${i + 1}`,
    case_id: 'c-files-1',
    position: i + 1,
    content_type: 'image/png',
    bytes: 2048,
    width: 10,
    height: 10,
    sha256: 'c'.repeat(64),
    caption: `Shot ${i + 1}`,
    filename: `shot-${i + 1}.png`,
    uploaded_by: 't1',
    uploaded_at: '2026-11-23T10:10:00Z',
    has_thumbnail: false,
    deleted: false,
    can_delete: false,
  })),
  deleted: [],
  count,
  bytes: count * 2048,
  can_upload: true,
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

const TIER1 = ['cases:read', 'cases:write', 'cases:comment', 'cases:close'];

beforeAll(async () => {
  // The kit's chunks, loaded up front so they render inside the test's own act() scope.
  await import('@/soc/pages/casedetail/files/CaseFiles');
  await import('@/soc/pages/casedetail/files/CloseScreenshots');
});

beforeEach(() => {
  env.grants = new Set(TIER1);
  env.streams = [];
  env.listing = listing(1);
  vi.mocked(listCaseFiles).mockClear();
  vi.mocked(uploadCaseFile).mockClear();
  vi.mocked(getThread).mockClear();
});

const pastedImage = (name: string) => ({
  clipboardData: { files: [new File([new Uint8Array(3)], name, { type: 'image/png' })], items: [] },
});

async function openCollaboration() {
  render(<CaseDetail caseId="c-files-1" presentation="embedded" onClose={() => undefined} />);
  await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent('Phishing link clicked'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: /Collaboration/ }));
  return within(await screen.findByTestId('collaboration-files'));
}

describe('the Collaboration Files section', () => {
  it('mounts the gallery under the Files heading with its count, and no second heading', async () => {
    const files = await openCollaboration();
    expect(files.getByRole('heading', { name: /Files/ })).toBeInTheDocument();
    expect(await files.findByText('Shot 1')).toBeInTheDocument();
    expect(await files.findByText('1 of 20')).toBeInTheDocument();
    expect(files.queryByRole('heading', { name: 'Screenshots' })).toBeNull();
    // The server says this viewer may upload: the drop zone is there.
    expect(files.getByRole('button', { name: 'Add screenshots' })).toBeEnabled();
    expect(listCaseFiles).toHaveBeenCalledWith('c-files-1', expect.anything());
  });

  it('offers no upload where the server says the viewer may not', async () => {
    env.listing = listing(1, { can_upload: false });
    const files = await openCollaboration();
    expect(await files.findByText('Shot 1')).toBeInTheDocument();
    expect(files.queryByRole('button', { name: 'Add screenshots' })).toBeNull();
  });

  it("re-reads the files on the thread stream's screenshot frame, and the thread on any other", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openCollaboration();
      await waitFor(() => expect(listCaseFiles).toHaveBeenCalledTimes(1));
      const thread = env.streams.filter((s) => s.topics.includes('cases:c-files-1'));
      expect(thread.length).toBeGreaterThan(0);
      const onEvent = thread[thread.length - 1].onEvent!;
      const threadReads = vi.mocked(getThread).mock.calls.length;

      env.listing = listing(2);
      act(() => {
        onEvent({
          type: 'case.activity',
          data: { case_id: 'c-files-1', kind: 'file_attached', actor: 't2', ref: { file_id: 'f2' } },
        });
      });
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      await waitFor(() => expect(listCaseFiles).toHaveBeenCalledTimes(2));
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(vi.mocked(getThread).mock.calls.length).toBe(threadReads);

      act(() => {
        onEvent({ type: 'case.activity', data: { case_id: 'c-files-1', kind: 'message' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      await waitFor(() => expect(vi.mocked(getThread).mock.calls.length).toBe(threadReads + 1));
      expect(listCaseFiles).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds an image pasted anywhere in the tab, the thread composer included, once', async () => {
    await openCollaboration();
    await screen.findByText('Shot 1');
    // The thread's composer: a text field of the tab, outside the Files section.
    const tab = document.querySelector<HTMLElement>('[data-case-panel="collaboration"]')!;
    const files = screen.getByTestId('collaboration-files');
    const composer = within(tab).getAllByRole('textbox').find((el) => !files.contains(el))!;
    await act(async () => {
      fireEvent.paste(composer, pastedImage('from-composer.png'));
    });
    await waitFor(() => expect(uploadCaseFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadCaseFile).mock.calls[0][0]).toBe('c-files-1');
    expect(vi.mocked(uploadCaseFile).mock.calls[0][1]).toMatchObject({ filename: 'from-composer.png' });
    // The Files section reads its list again once the upload lands.
    await waitFor(() => expect(listCaseFiles).toHaveBeenCalledTimes(2));
    expect(uploadCaseFile).toHaveBeenCalledTimes(1);
  });

  it('opens no stream of its own: the files kit rides on the thread stream', () => {
    const dir = path.resolve(__dirname, '..', 'casedetail', 'files');
    for (const name of readdirSync(dir).filter((n) => /\.tsx?$/.test(n))) {
      expect(readFileSync(path.join(dir, name), 'utf8'), name).not.toMatch(/useEventStream/);
    }
  });
});

describe('the close dialog', () => {
  async function openClose() {
    render(<CaseDetail caseId="c-files-1" presentation="embedded" onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector('[data-case-title]')).toHaveTextContent('Phishing link clicked'));
    fireEvent.click(screen.getByTestId('case-primary-action'));
    return screen.findByTestId('confirm-action-dialog');
  }

  it('offers Add screenshots to a viewer who may add them', async () => {
    const dialog = await openClose();
    const zone = await within(dialog).findByTestId('close-screenshots');
    expect(within(zone).getByRole('button', { name: 'Add screenshots' })).toBeEnabled();
    expect(within(dialog).getByTestId('confirm-action-screenshots')).toHaveTextContent('Screenshots (optional)');
  });

  it('takes a paste inside the dialog once, even with the Collaboration tab open behind it', async () => {
    await openCollaboration();
    await screen.findByText('Shot 1');
    fireEvent.click(screen.getByTestId('case-primary-action'));
    const dialog = await screen.findByTestId('confirm-action-dialog');
    await within(dialog).findByTestId('close-screenshots');
    const note = within(dialog).getAllByRole('textbox').at(-1)!;
    await act(async () => {
      fireEvent.paste(note, pastedImage('in-dialog.png'));
    });
    await waitFor(() => expect(uploadCaseFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(uploadCaseFile).mock.calls[0][1]).toMatchObject({ filename: 'in-dialog.png' });
    expect(await within(dialog).findByText('in-dialog.png: added to the case')).toBeInTheDocument();
    // The tab behind the dialog never caught it: one upload, not two.
    expect(uploadCaseFile).toHaveBeenCalledTimes(1);
  });

  it('offers none to a viewer without cases:comment', async () => {
    env.grants = new Set(['cases:read', 'cases:write', 'cases:close']);
    const dialog = await openClose();
    await within(dialog).findByText('Disposition');
    expect(within(dialog).queryByTestId('close-screenshots')).toBeNull();
    expect(within(dialog).queryByTestId('confirm-action-screenshots')).toBeNull();
  });
});
