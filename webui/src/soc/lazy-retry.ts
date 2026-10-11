/**
 * A lazy chunk loader that a failed fetch never poisons for the rest of the page's life.
 *
 * Chromium caches a failed module fetch under its URL for as long as the document lives,
 * so every later `import()` of the same chunk rejects at once, even after the network
 * recovers. The shell warms its lazy chunks in the background (the command palette when
 * the browser is idle), so a passing network blip during that warm would otherwise
 * disable the feature until a reload. This loader:
 *
 * - forgets a failed attempt, so the next call (the analyst's own click) tries again;
 * - on a failure whose error names the chunk's URL (Chromium and Firefox say "…
 *   dynamically imported module: <url>"), asks for the same file under a fresh query
 *   (`?retry=N`), which the browser treats as a new module and fetches again. Only a
 *   same-origin `.js` URL is ever retried this way;
 * - keeps a successful load, so the chunk is fetched once.
 *
 * Dependency-free and tiny: it ships in the entry chunk with AppShell.
 */

const FAILED_IMPORT_RE = /dynamically imported module:?\s+(\S+)/i;

/** The chunk URL a failed dynamic import names, when it is a same-origin `.js` file. */
export function failedModuleUrl(error: unknown, origin: string = window.location.origin): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = FAILED_IMPORT_RE.exec(message);
  if (!match) return null;
  try {
    const url = new URL(match[1], origin);
    if (url.origin !== origin || !url.pathname.endsWith('.js')) return null;
    url.searchParams.delete('retry');
    return url.href;
  } catch {
    return null;
  }
}

export type RetryImport<T> = (url: string) => Promise<T>;

// `@vite-ignore`: the URL is the chunk's own built URL, known only at run time.
const importUrl = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;

/** `load` wrapped so that a failure is retried on the next call and never remembered. */
export function retryingLoader<T>(
  load: () => Promise<T>,
  retryImport: RetryImport<T> = importUrl,
  origin?: string,
): () => Promise<T> {
  let pending: Promise<T> | null = null;
  let retries = 0;
  return () => {
    if (pending) return pending;
    const attempt = load().catch((error: unknown) => {
      const url = failedModuleUrl(error, origin ?? window.location.origin);
      if (!url) throw error;
      retries += 1;
      const fresh = new URL(url);
      fresh.searchParams.set('retry', String(retries));
      return retryImport(fresh.href);
    });
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
    return attempt;
  };
}
