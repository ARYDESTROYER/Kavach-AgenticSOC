/**
 * Round 15 (SPEC D5.12): the browser side of a screenshot upload. Lazy kit only, never
 * the entry `lib/avatar.ts` ([ru] L4): imported by the Files kit, so the canvas code
 * ships with it.
 *
 * Every picked, pasted or dropped image is decoded and drawn onto a canvas, which
 * removes its metadata (EXIF and the rest), applies its orientation and turns GIF, BMP
 * or any other format the browser can decode into a still image. It is then encoded
 * with this ladder until it fits the 2 MiB the server stores:
 *
 *   longest side at most 3,840 px: PNG (lossless, best for text), then WebP 0.92,
 *   then JPEG 0.9; then the same at 2,560 px and at 1,920 px; then a refusal.
 *
 * The emitted type is trusted, never the requested one (a browser may decline WebP).
 * A thumbnail (longest side 320 px, then 240 px; WebP then JPEG) is made beside it
 * when one fits in 48 KiB; without one the server serves the full image instead.
 * The server validates everything again: this is a convenience, not the guard.
 */

/** What the server stores for one screenshot, at most (`engine/case_images.py`). */
export const MAX_STORED_BYTES = 2 * 1024 * 1024;
/** What the server stores for one thumbnail, at most. */
export const MAX_THUMBNAIL_BYTES = 48 * 1024;
/** The longest sides tried, in order (SPEC D5.12). */
export const SIDE_LADDER = [3840, 2560, 1920] as const;
/** The longest sides tried for a thumbnail. */
export const THUMBNAIL_SIDES = [320, 240] as const;
/** Files larger than this are refused before they are decoded. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
/** The types the server accepts, so the only ones an encoding may end in. */
export const ACCEPTED_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const;

type Encoding = readonly [type: string, quality: number | undefined];
const IMAGE_ENCODINGS: readonly Encoding[] = [
  ['image/png', undefined],
  ['image/webp', 0.92],
  ['image/jpeg', 0.9],
];
const THUMBNAIL_ENCODINGS: readonly Encoding[] = [
  ['image/webp', 0.8],
  ['image/jpeg', 0.8],
  ['image/webp', 0.6],
  ['image/jpeg', 0.6],
];

/** A refusal with Console copy (plain text). */
export class ScreenshotPrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotPrepError';
  }
}

/** The part of a canvas this module uses (so tests can pass a fake). */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): Pick<
    CanvasRenderingContext2D,
    'drawImage' | 'fillRect' | 'imageSmoothingEnabled' | 'imageSmoothingQuality' | 'fillStyle'
  > | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

/** A decoded image ready to draw. */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

export interface EncodedImage {
  blob: Blob;
  type: string;
  width: number;
  height: number;
}

export interface PreparedScreenshot {
  image: EncodedImage;
  thumbnail: EncodedImage | null;
}

export interface PrepDeps {
  decode: (file: Blob) => Promise<DecodedImage>;
  createCanvas: (width: number, height: number) => CanvasLike;
}

/** The dimensions of `width` by `height` scaled down (never up) to `maxSide`. */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function toBlob(canvas: CanvasLike, type: string, quality: number | undefined): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function draw(
  deps: PrepDeps,
  image: DecodedImage,
  size: { width: number; height: number },
  opaque: boolean,
): CanvasLike {
  const canvas = deps.createCanvas(size.width, size.height);
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ScreenshotPrepError('This browser could not process the image.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (opaque) {
    // JPEG has no transparency: paint white under it instead of black.
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size.width, size.height);
  }
  ctx.drawImage(image.source, 0, 0, size.width, size.height);
  return canvas;
}

/**
 * The first encoding of `image` at `size` whose emitted type is accepted and whose
 * size is at most `maxBytes`, or `null`.
 */
export async function encodeUnder(
  deps: PrepDeps,
  image: DecodedImage,
  size: { width: number; height: number },
  encodings: readonly Encoding[],
  maxBytes: number,
): Promise<EncodedImage | null> {
  let transparent: CanvasLike | null = null;
  let opaque: CanvasLike | null = null;
  for (const [type, quality] of encodings) {
    const isJpeg = type === 'image/jpeg';
    const canvas = isJpeg
      ? (opaque ??= draw(deps, image, size, true))
      : (transparent ??= draw(deps, image, size, false));
    const blob = await toBlob(canvas, type, quality);
    if (!blob || !(ACCEPTED_TYPES as readonly string[]).includes(blob.type)) continue;
    if (blob.size <= maxBytes) return { blob, type: blob.type, width: size.width, height: size.height };
  }
  return null;
}

async function defaultDecode(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      /* fall back to an <img> below */
    }
  }
  // An older browser without createImageBitmap: decode through an <img> from a data URL.
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ScreenshotPrepError('The image could not be read.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode'));
      el.src = src;
    });
    return { source: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  } catch {
    throw new ScreenshotPrepError('That file is not an image this browser can open.');
  }
}

export const defaultPrepDeps: PrepDeps = {
  decode: defaultDecode,
  createCanvas: (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
  },
};

/**
 * Decode, redraw and encode one image for upload (see the module comment). Rejects
 * with a {@link ScreenshotPrepError} whose message the Console shows as is.
 */
export async function prepareScreenshot(file: Blob, deps: PrepDeps = defaultPrepDeps): Promise<PreparedScreenshot> {
  if (!file || file.size === 0) throw new ScreenshotPrepError('That file is empty.');
  if (file.type && !file.type.startsWith('image/')) {
    throw new ScreenshotPrepError('Only images can be added as screenshots.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new ScreenshotPrepError(
      `That file is larger than ${(MAX_INPUT_BYTES / (1024 * 1024)).toLocaleString('en-US')} MB.`,
    );
  }
  let decoded: DecodedImage;
  try {
    decoded = await deps.decode(file);
  } catch (e) {
    if (e instanceof ScreenshotPrepError) throw e;
    throw new ScreenshotPrepError('That file is not an image this browser can open.');
  }
  try {
    if (!(decoded.width > 0 && decoded.height > 0)) {
      throw new ScreenshotPrepError('That image has no width or height.');
    }
    let image: EncodedImage | null = null;
    for (const side of SIDE_LADDER) {
      image = await encodeUnder(
        deps,
        decoded,
        fitWithin(decoded.width, decoded.height, side),
        IMAGE_ENCODINGS,
        MAX_STORED_BYTES,
      );
      if (image) break;
    }
    if (!image) {
      throw new ScreenshotPrepError(
        'This image is too detailed to fit in 2 MB, even at 1,920 pixels. Crop it and try again.',
      );
    }
    let thumbnail: EncodedImage | null = null;
    for (const side of THUMBNAIL_SIDES) {
      thumbnail = await encodeUnder(
        deps,
        decoded,
        fitWithin(decoded.width, decoded.height, side),
        THUMBNAIL_ENCODINGS,
        MAX_THUMBNAIL_BYTES,
      );
      if (thumbnail) break;
    }
    return { image, thumbnail };
  } finally {
    decoded.close?.();
  }
}

/** A Blob as bare base64 (no `data:` prefix), for the JSON upload body. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ScreenshotPrepError('The image could not be read.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) reject(new ScreenshotPrepError('The image could not be read.'));
      else resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
