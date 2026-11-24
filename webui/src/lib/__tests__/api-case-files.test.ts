/**
 * Round 15 (SPEC D5.5, D5.12): the case screenshot client sends the routes the backend
 * serves, encodes ids, reads content as a Blob through the shared request flow and
 * keeps the server-generated file name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteCaseFile, fetchCaseFileBlob, listCaseFiles, uploadCaseFile } from '../api-case-files';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }));
  return calls;
}

const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('api-case-files', () => {
  it('lists, uploads and deletes on the case routes', async () => {
    const calls = stubFetch(json({ ok: true }));
    await listCaseFiles('case/1');
    await uploadCaseFile('case/1', { data_base64: 'eA==', content_type: 'image/png', caption: 'x' });
    await deleteCaseFile('case/1', 'f'.repeat(32));
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', '/api/cases/case%2F1/files'],
      ['POST', '/api/cases/case%2F1/files'],
      ['DELETE', `/api/cases/case%2F1/files/${'f'.repeat(32)}`],
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ data_base64: 'eA==', content_type: 'image/png', caption: 'x' });
    expect(calls.every((c) => c.init.credentials === 'include')).toBe(true);
  });

  it('reads content as a Blob and keeps the server file name', async () => {
    const calls = stubFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="SOC-0042-1.png"' },
        }),
    );
    const out = await fetchCaseFileBlob('case-1', 'a'.repeat(32), { variant: 'thumb', download: true });
    expect(calls[0].url).toBe(`/api/cases/case-1/files/${'a'.repeat(32)}/content?variant=thumb&download=1`);
    expect(out.filename).toBe('SOC-0042-1.png');
    expect(out.blob.size).toBe(3);
  });

  it('surfaces a refusal as the shared API error', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ detail: { code: 'case_file_not_found', message: 'That screenshot was not found.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(fetchCaseFileBlob('case-1', 'b'.repeat(32))).rejects.toMatchObject({ status: 404 });
  });
});
