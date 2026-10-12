/**
 * Lazy chunks that a failed fetch never poisons for the rest of the page's life.
 *
 * Chromium caches a failed module fetch under its URL for as long as the document lives,
 * so every later `import()` of that chunk, or of any chunk that statically imports it,
 * rejects at once, even after the network recovers. Two rules follow:
 *
 * - **Warm with a prefetch, never with `import()`** (`prefetchChunks`). A background
 *   warm (the command palette when the browser is idle) only fills the HTTP cache, so a
 *   warm that fails during a network blip leaves no trace: the analyst's own open
 *   fetches the chunk as if no warm had run, and no other feature that shares its chunks
 *   (cmdk with Chat, the Settings metadata with Settings) is affected.
 * - **Retry an open under a fresh URL** (`retryingLoader`). A failed attempt is
 *   forgotten, and a failure whose error names the chunk's URL (Chromium and Firefox
 *   say "… dynamically imported module: <url>") is retried once as `<url>?retry=N`,
 *   which the browser fetches as a new module. Only a same-origin `.js` URL is retried.
 *   The retry cannot reach a module the chunk imports: one that failed stays failed
 *   until a reload, so a caller that reports a failure offers a reload, never "try
 *   again" alone.
 *
 * Dependency-free and tiny: it ships in the entry chunk with AppShell.
 */

const FAILED_IMPORT_RE = /dynamically imported module:?\s+(\S+?\.js)\b/i;

/** The chunk URL a failed dynamic import names, when it is a same-origin `.js` file. */
export function failedModuleUrl(error: unknown, origin: string = window.location.origin): string | null {
  const url = FAILED_IMPORT_RE.exec(String((error as Error | null)?.message ?? error))?.[1];
  return url && url.startsWith(`${origin}/`) ? url : null;
}

export type RetryImport<T> = (url: string) => Promise<T>;

/** `load` wrapped so that a failure is retried on the next call and never remembered. */
export function retryingLoader<T>(
  load: () => Promise<T>,
  // `@vite-ignore`: the URL is the chunk's own built URL, known only at run time.
  retryImport: RetryImport<T> = (url) => import(/* @vite-ignore */ url) as Promise<T>,
  origin?: string,
): () => Promise<T> {
  let pending: Promise<T> | null = null;
  let retries = 0;
  return () =>
    (pending ??= load()
      .catch((error: unknown) => {
        const url = failedModuleUrl(error, origin);
        if (!url) throw error;
        retries += 1;
        return retryImport(`${url}?retry=${retries}`);
      })
      .catch((error: unknown) => {
        pending = null;
        throw error;
      }));
}

const prefetched = new Set<string>();

/**
 * Warm chunks into the HTTP cache without loading them as modules
 * (`<link rel="prefetch">`). `list` is the JSON list of chunk paths, relative to `base`,
 * that the build writes in place of a `'__CHUNK_LIST:…__'` mark (vite.config.ts
 * `chunkListPlugin`); unbuilt (the dev server, tests) the mark stays and nothing is
 * warmed. A list is warmed at most once per page; a prefetch that fails changes nothing,
 * since the open imports the chunk anyway.
 */
export function prefetchChunks(list: string, base: string): void {
  if (!list.startsWith('[') || prefetched.has(list)) return;
  prefetched.add(list);
  for (const name of JSON.parse(list) as string[]) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'prefetch', href: new URL(name, base).href }));
  }
}
