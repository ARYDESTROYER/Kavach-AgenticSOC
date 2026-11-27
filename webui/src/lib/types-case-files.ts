/**
 * Round 15 (SPEC D5.5, D5.12): the case screenshot wire types, mirroring the
 * feature-local response models of `backend/app/api/routes_case_files.py`. Type-only:
 * nothing here ships at first paint.
 *
 * Captions and filenames are text a person typed (plain text, rendered as text nodes
 * only); the server never quotes them in an audit summary and never sends them to a
 * model.
 */

/** One screenshot as the API lists it (metadata only, never the bytes). */
export interface CaseFileEntry {
  id: string;
  case_id: string;
  /** 1-based number of the screenshot on its case, in upload order. */
  position: number;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp' | string;
  /** Stored size of the full image, after its metadata was removed. */
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  caption: string;
  filename: string;
  uploaded_by: string;
  uploaded_at: string;
  has_thumbnail: boolean;
  thumbnail_bytes?: number | null;
  deleted: boolean;
  deleted_at?: string | null;
  deleted_by?: string | null;
  /** The caller may delete it: their own upload, or they hold `cases:close`. */
  can_delete: boolean;
}

/** The bounds the server applies (Demo Mode and the in-memory store are lower). */
export interface CaseFileLimits {
  max_files: number;
  max_case_bytes: number;
  max_file_bytes: number;
  max_thumbnail_bytes: number;
  max_side_px: number;
  max_pixels: number;
  max_caption_chars: number;
  max_filename_chars: number;
  accepted_types: string[];
}

/** `GET /api/cases/{id}/files`. */
export interface CaseFileList {
  case_id: string;
  files: CaseFileEntry[];
  /** Deleted screenshots: their metadata is kept, their bytes are gone. */
  deleted: CaseFileEntry[];
  count: number;
  bytes: number;
  /** The caller holds `cases:comment`. */
  can_upload: boolean;
  limits: CaseFileLimits;
}

/** `POST /api/cases/{id}/files` body. `data_base64` may also be a `data:` URL. */
export interface CaseFileUploadBody {
  data_base64: string;
  content_type?: string | null;
  thumbnail_base64?: string | null;
  filename?: string;
  caption?: string;
}

/** `POST /api/cases/{id}/files` (201, or 200 with `deduplicated` for the same image). */
export interface CaseFileUploadResult {
  file: CaseFileEntry;
  deduplicated: boolean;
}

/** `DELETE /api/cases/{id}/files/{file_id}`. */
export interface CaseFileDeleteResult {
  file: CaseFileEntry;
  deleted: boolean;
}

export type CaseFileVariant = 'full' | 'thumb';
