/**
 * Round 15 (SPEC D5.12): the browser re-encode ladder. A fake canvas answers each
 * `toBlob(type, quality)` with a Blob of a size the test chooses, so every rung of the
 * ladder (3,840, 2,560, 1,920 px; PNG, WebP 0.92, JPEG 0.9) and the refusal are pinned
 * without a real canvas.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_STORED_BYTES,
  MAX_THUMBNAIL_BYTES,
  ScreenshotPrepError,
  blobToBase64,
  fitWithin,
  prepareScreenshot,
} from '../image-encode';
import type { CanvasLike, PrepDeps } from '../image-encode';

interface Call {
  width: number;
  type: string;
  quality: number | undefined;
}

/** A canvas whose encoding size is `sizeOf(width, type)`; `emit` may change the type. */
function fakeDeps(
  sizeOf: (width: number, type: string) => number,
  options: { width?: number; height?: number; emit?: (type: string) => string; close?: () => void } = {},
): { deps: PrepDeps; calls: Call[]; fills: string[] } {
  const calls: Call[] = [];
  const fills: string[] = [];
  const deps: PrepDeps = {
    decode: async () => ({
      source: {} as CanvasImageSource,
      width: options.width ?? 5000,
      height: options.height ?? 2500,
      close: options.close,
    }),
    createCanvas: (width, height) => {
      const canvas: CanvasLike = {
        width,
        height,
        getContext: () =>
          ({
            drawImage: vi.fn(),
            fillRect: vi.fn(() => fills.push(`${canvas.width}`)),
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
            fillStyle: '',
          }) as unknown as ReturnType<CanvasLike['getContext']>,
        toBlob: (callback, type = 'image/png', quality) => {
          calls.push({ width: canvas.width, type, quality });
          const emitted = options.emit ? options.emit(type) : type;
          callback(new Blob([new Uint8Array(sizeOf(canvas.width, type))], { type: emitted }));
        },
      };
      return canvas;
    },
  };
  return { deps, calls, fills };
}

const file = (type = 'image/png', size = 1000) => new File([new Uint8Array(size)], 'shot.png', { type });

describe('fitWithin', () => {
  it('scales the longest side down and never up', () => {
    expect(fitWithin(7680, 4320, 3840)).toEqual({ width: 3840, height: 2160 });
    expect(fitWithin(1000, 4000, 2560)).toEqual({ width: 640, height: 2560 });
    expect(fitWithin(800, 600, 3840)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 1, 1920)).toEqual({ width: 1920, height: 1 });
  });
});

describe('prepareScreenshot', () => {
  it('keeps a lossless PNG at 3,840 px when it fits', async () => {
    const { deps, calls } = fakeDeps(() => 1_000_000);
    const out = await prepareScreenshot(file(), deps);
    expect(out.image.type).toBe('image/png');
    expect([out.image.width, out.image.height]).toEqual([3840, 1920]);
    expect(calls[0]).toEqual({ width: 3840, type: 'image/png', quality: undefined });
  });

  it('falls to WebP 0.92, then JPEG 0.9, on the same side first', async () => {
    const webp = fakeDeps((_w, type) => (type === 'image/png' ? MAX_STORED_BYTES + 1 : 500_000));
    expect((await prepareScreenshot(file(), webp.deps)).image.type).toBe('image/webp');
    expect(webp.calls.slice(0, 2).map((c) => [c.type, c.quality])).toEqual([
      ['image/png', undefined],
      ['image/webp', 0.92],
    ]);

    const jpeg = fakeDeps((_w, type) => (type === 'image/jpeg' ? 900_000 : MAX_STORED_BYTES * 2));
    const out = await prepareScreenshot(file(), jpeg.deps);
    expect(out.image.type).toBe('image/jpeg');
    expect(out.image.width).toBe(3840);
    expect(jpeg.calls.find((c) => c.type === 'image/jpeg')?.quality).toBe(0.9);
  });

  it('steps down to 2,560 and then 1,920 px', async () => {
    const at2560 = fakeDeps((w) => (w > 2560 ? MAX_STORED_BYTES * 3 : 1_500_000));
    expect((await prepareScreenshot(file(), at2560.deps)).image.width).toBe(2560);
    const at1920 = fakeDeps((w) => (w > 1920 ? MAX_STORED_BYTES * 3 : 1_500_000));
    const out = await prepareScreenshot(file(), at1920.deps);
    expect(out.image.width).toBe(1920);
    expect(new Set(at1920.calls.filter((c) => c.width > 320).map((c) => c.width))).toEqual(new Set([3840, 2560, 1920]));
  });

  it('refuses with a plain message when nothing fits at 1,920 px', async () => {
    const { deps } = fakeDeps(() => MAX_STORED_BYTES + 1);
    await expect(prepareScreenshot(file(), deps)).rejects.toThrow(
      'This image is too detailed to fit in 2 MB, even at 1,920 pixels. Crop it and try again.',
    );
  });

  it('trusts the emitted type: a declined WebP never passes as WebP', async () => {
    const { deps } = fakeDeps((_w, type) => (type === 'image/png' ? MAX_STORED_BYTES + 1 : 1000), {
      emit: (type) => (type === 'image/webp' ? 'image/bmp' : type),
    });
    const out = await prepareScreenshot(file(), deps);
    expect(out.image.type).toBe('image/jpeg');
  });

  it('paints white under a JPEG only', async () => {
    const pngOnly = fakeDeps(() => 1000);
    await prepareScreenshot(file(), pngOnly.deps);
    const jpegFills = pngOnly.fills.filter((w) => Number(w) > 320);
    expect(jpegFills).toEqual([]);
    const jpeg = fakeDeps((_w, type) => (type === 'image/jpeg' ? 1000 : MAX_STORED_BYTES * 2));
    await prepareScreenshot(file(), jpeg.deps);
    expect(jpeg.fills.filter((w) => Number(w) > 320)).toEqual(['3840']);
  });

  it('makes a thumbnail under 48 KB, or none', async () => {
    const small = fakeDeps((w) => (w <= 320 ? 20_000 : 1000));
    const out = await prepareScreenshot(file(), small.deps);
    expect(out.thumbnail?.width).toBe(320);
    expect(out.thumbnail?.type).toBe('image/webp');
    const at240 = fakeDeps((w) => (w === 320 ? MAX_THUMBNAIL_BYTES + 1 : w === 240 ? 30_000 : 1000));
    expect((await prepareScreenshot(file(), at240.deps)).thumbnail?.width).toBe(240);
    const none = fakeDeps((w) => (w <= 320 ? MAX_THUMBNAIL_BYTES + 1 : 1000));
    expect((await prepareScreenshot(file(), none.deps)).thumbnail).toBeNull();
  });

  it('refuses empty files, other types and decode failures with plain copy', async () => {
    const { deps } = fakeDeps(() => 1000);
    await expect(prepareScreenshot(new File([], 'x.png', { type: 'image/png' }), deps)).rejects.toThrow(
      'That file is empty.',
    );
    await expect(prepareScreenshot(file('application/pdf'), deps)).rejects.toThrow(
      'Only images can be added as screenshots.',
    );
    const broken: PrepDeps = { ...deps, decode: () => Promise.reject(new Error('boom')) };
    await expect(prepareScreenshot(file(), broken)).rejects.toBeInstanceOf(ScreenshotPrepError);
    await expect(prepareScreenshot(file(), broken)).rejects.toThrow('That file is not an image this browser can open.');
  });

  it('releases the decoded image', async () => {
    const close = vi.fn();
    const { deps } = fakeDeps(() => 1000, { close });
    await prepareScreenshot(file(), deps);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('blobToBase64', () => {
  it('returns bare base64 without the data URL prefix', async () => {
    const out = await blobToBase64(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    expect(out).toBe('iVBORw==');
  });
});
