/**
 * Round 15 (SPEC D5.5, D5.12): the case screenshot client. Lazy-only: imported by the
 * case Files kit (`soc/pages/casedetail/files/`), never by an entry module, so none of
 * it ships at first paint (§3.1). Every call goes through the shared request helpers,
 * so the 401, step-up and error contract is the same as everywhere else; image bytes
 * are read with the exported `requestResponse` as a Blob (never a plain `<img src>`,
 * which would bypass that flow).
 */
import { request, requestResponse } from './api';
import type {
  CaseFileDeleteResult,
  CaseFileList,
  CaseFileUploadBody,
  CaseFileUploadResult,
  CaseFileVariant,
} from './types-case-files';

const base = (caseId: string) => `cases/${encodeURIComponent(caseId)}/files`;

/** `GET /api/cases/{id}/files`: the case's screenshots, metadata only. */
export function listCaseFiles(caseId: string, signal?: AbortSignal): Promise<CaseFileList> {
  return request<CaseFileList>('GET', base(caseId), { signal });
}

/**
 * `POST /api/cases/{id}/files`. The same image again answers the existing entry with
 * `deduplicated: true`. Refusals carry a `code` (`case_files_case_full`,
 * `case_files_storage_full`, `case_files_busy`, `case_files_unsupported_type`, ...).
 */
export function uploadCaseFile(
  caseId: string,
  body: CaseFileUploadBody,
  signal?: AbortSignal,
): Promise<CaseFileUploadResult> {
  return request<CaseFileUploadResult>('POST', base(caseId), { body, signal });
}

/** `DELETE /api/cases/{id}/files/{file_id}`: the bytes go, the metadata stays. */
export function deleteCaseFile(caseId: string, fileId: string): Promise<CaseFileDeleteResult> {
  return request<CaseFileDeleteResult>('DELETE', `${base(caseId)}/${encodeURIComponent(fileId)}`);
}

/** One screenshot's bytes, read as a Blob, and the server-generated file name. */
export interface CaseFileBlob {
  blob: Blob;
  filename: string;
}

const FILENAME_RE = /filename="([^"]+)"/;

/**
 * `GET /api/cases/{id}/files/{file_id}/content`. `variant: 'thumb'` asks for the
 * thumbnail (the full image when there is none); `download` asks for an attachment
 * disposition, whose server-generated ASCII name is returned.
 */
export async function fetchCaseFileBlob(
  caseId: string,
  fileId: string,
  options: { variant?: CaseFileVariant; download?: boolean; signal?: AbortSignal } = {},
): Promise<CaseFileBlob> {
  const query: Record<string, unknown> = { variant: options.variant ?? 'full' };
  if (options.download) query.download = 1;
  const res = await requestResponse('GET', `${base(caseId)}/${encodeURIComponent(fileId)}/content`, {
    query,
    signal: options.signal,
  });
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = FILENAME_RE.exec(disposition)?.[1] ?? 'screenshot';
  return { blob: await res.blob(), filename: name };
}
