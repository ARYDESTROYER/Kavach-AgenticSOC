/**
 * soc/lazy-retry: `retryingLoader` fetches a lazy chunk whose open failed again on the
 * next call, under a fresh query when the browser named the failed URL, and keeps a
 * success; `prefetchChunks` warms a build-written chunk list into the HTTP cache with
 * `<link rel="prefetch">`, never through `import()` (a failed module fetch would stay
 * failed for the life of the page, for every feature sharing the chunk).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { failedModuleUrl, prefetchChunks, retryingLoader } from '../lazy-retry';

const ORIGIN = 'https://soc.example';
const CHROMIUM = `Failed to fetch dynamically imported module: ${ORIGIN}/assets/CommandPalette-abc123.js`;
const FIREFOX = `error loading dynamically imported module: ${ORIGIN}/assets/CommandPalette-abc123.js`;

describe('failedModuleUrl', () => {
  it('reads the chunk URL from Chromium and Firefox import errors', () => {
    expect(failedModuleUrl(new TypeError(CHROMIUM), ORIGIN)).toBe(`${ORIGIN}/assets/CommandPalette-abc123.js`);
    expect(failedModuleUrl(new TypeError(FIREFOX), ORIGIN)).toBe(`${ORIGIN}/assets/CommandPalette-abc123.js`);
    // A retried URL is read back without its retry query.
    expect(failedModuleUrl(new TypeError(`${CHROMIUM}?retry=2`), ORIGIN)).toBe(
      `${ORIGIN}/assets/CommandPalette-abc123.js`,
    );
  });

  it('never names another origin, a non-script file or an error without a URL', () => {
    expect(failedModuleUrl(new TypeError('Failed to fetch dynamically imported module: https://evil.example/x.js'), ORIGIN)).toBeNull();
    expect(failedModuleUrl(new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/index.html`), ORIGIN)).toBeNull();
    expect(failedModuleUrl(new TypeError('Importing a module script failed.'), ORIGIN)).toBeNull();
    expect(failedModuleUrl(undefined, ORIGIN)).toBeNull();
  });
});

describe('retryingLoader', () => {
  it('fetches a failed chunk again under a fresh query and keeps the success', async () => {
    const load = vi.fn().mockRejectedValue(new TypeError(CHROMIUM));
    const retry = vi.fn().mockResolvedValue('module');
    const loader = retryingLoader(load, retry, ORIGIN);
    await expect(loader()).resolves.toBe('module');
    expect(retry).toHaveBeenCalledWith(`${ORIGIN}/assets/CommandPalette-abc123.js?retry=1`);
    await expect(loader()).resolves.toBe('module');
    expect(load).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure: the next call tries again with a new query', async () => {
    const load = vi.fn().mockRejectedValue(new TypeError(CHROMIUM));
    const retry = vi.fn().mockRejectedValueOnce(new TypeError(`${CHROMIUM}?retry=1`)).mockResolvedValue('module');
    const loader = retryingLoader(load, retry, ORIGIN);
    await expect(loader()).rejects.toThrow(TypeError);
    await expect(loader()).resolves.toBe('module');
    expect(retry.mock.calls.map((c) => c[0])).toEqual([
      `${ORIGIN}/assets/CommandPalette-abc123.js?retry=1`,
      `${ORIGIN}/assets/CommandPalette-abc123.js?retry=2`,
    ]);
  });

  it('retries the plain load when the error names no URL', async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError('Importing a module script failed.')).mockResolvedValue('ok');
    const retry = vi.fn();
    const loader = retryingLoader(load, retry, ORIGIN);
    await expect(loader()).rejects.toThrow('Importing a module script failed.');
    await expect(loader()).resolves.toBe('ok');
    expect(retry).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one attempt between concurrent callers (a warm and an open)', async () => {
    let resolve: (value: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((r) => { resolve = r; }));
    const loader = retryingLoader(load, vi.fn(), ORIGIN);
    const warm = loader();
    const open = loader();
    resolve('module');
    await expect(Promise.all([warm, open])).resolves.toEqual(['module', 'module']);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('prefetchChunks', () => {
  const links = () =>
    [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')].map((l) => l.href);
  afterEach(() => document.head.querySelectorAll('link[rel="prefetch"]').forEach((l) => l.remove()));

  it('prefetches every chunk of a build-written list, relative to the chunk that holds it', () => {
    const list = JSON.stringify(['CommandPalette-abc.js', 'command-def.js', 'settings-sections-meta-ghi.js']);
    prefetchChunks(list, `${ORIGIN}/assets/index-123.js`);
    expect(links()).toEqual([
      `${ORIGIN}/assets/CommandPalette-abc.js`,
      `${ORIGIN}/assets/command-def.js`,
      `${ORIGIN}/assets/settings-sections-meta-ghi.js`,
    ]);
    // A plain prefetch: no module preload, nothing for the page's module map.
    expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull();
    // Once per page: the idle warm and any later warm add nothing.
    prefetchChunks(list, `${ORIGIN}/assets/index-123.js`);
    expect(links()).toHaveLength(3);
  });

  it('warms nothing when the build did not write the list (dev server, tests)', () => {
    prefetchChunks('__TLSOC_CHUNKS:src/soc/components/CommandPalette.tsx__', `${ORIGIN}/assets/index-123.js`);
    expect(links()).toEqual([]);
  });
});
