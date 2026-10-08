import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import {
  BUNDLED_DOCUMENTATION,
  resolveDocumentationAlias,
  resolveDocumentationDirectory,
} from './docs.config';
import { releaseEntryId, resolveBuildReleaseIdentity } from './release.config';

/**
 * Vite config for Agentic SOC.
 *
 * In dev, the SPA is served on :5173 and all `/api/*` calls are proxied to the
 * FastAPI backend on :8088, so the browser talks to the backend DIRECTLY (there
 * is no Kibana proxy in the standalone deployment). Set `BACKEND_URL` to point at
 * a different backend during development.
 */
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8088';
const RELEASE_IDENTITY = resolveBuildReleaseIdentity();
const RELEASE_ENTRY_ID = releaseEntryId(RELEASE_IDENTITY);
const DEV_DOCS_ROOT = path.resolve(__dirname, 'public/docs');
const PREVIEW_DOCS_ROOT = path.resolve(__dirname, 'dist/docs');
const RELEASE_MANIFEST_PATH = '/release.json';

function releaseManifestSource(): string {
  return `${JSON.stringify({ schema: 1, product: 'agentic-soc', entryId: RELEASE_ENTRY_ID, ...RELEASE_IDENTITY }, null, 2)}\n`;
}

/**
 * Emit the immutable identity of the deployed Web bundle as a tiny no-store file.
 * A running older Console can observe it without downloading or executing new code.
 */
function releaseManifestPlugin(): Plugin {
  const source = releaseManifestSource();
  const devBoundary: Connect.NextHandleFunction = (request, response, next) => {
    if (!request.url) return next();
    const pathname = new URL(request.url, 'http://tlsoc.local').pathname;
    if (pathname !== RELEASE_MANIFEST_PATH) return next();
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    response.end(source);
  };
  const previewBoundary: Connect.NextHandleFunction = (request, response, next) => {
    if (request.url) {
      const pathname = new URL(request.url, 'http://tlsoc.local').pathname;
      if (pathname === RELEASE_MANIFEST_PATH) {
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    }
    next();
  };
  return {
    name: 'tlsoc-release-manifest',
    configureServer(server) {
      server.middlewares.use(devBoundary);
    },
    configurePreviewServer(server) {
      server.middlewares.use(previewBoundary);
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'tlsoc-release', content: RELEASE_ENTRY_ID },
          injectTo: 'head',
        },
      ];
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: RELEASE_MANIFEST_PATH.slice(1), source });
    },
  };
}

function docsRequestBoundary(docsRoot: string): Connect.NextHandleFunction {
  return (request, response, next) => {
    if (!request.url) return next();
    const requestUrl = new URL(request.url, 'http://tlsoc.local');
    if (requestUrl.pathname !== '/docs' && !requestUrl.pathname.startsWith('/docs/')) {
      return next();
    }

    const alias = resolveDocumentationAlias(requestUrl.pathname, BUNDLED_DOCUMENTATION);
    if (alias) {
      response.statusCode = 307;
      response.setHeader('Location', `${alias}${requestUrl.search}${requestUrl.hash}`);
      response.end();
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(requestUrl.pathname.slice('/docs/'.length));
    } catch {
      response.statusCode = 400;
      response.end('Malformed documentation path');
      return;
    }
    const candidate = path.resolve(docsRoot, decodedPath);
    const insideDocs = candidate === docsRoot || candidate.startsWith(`${docsRoot}${path.sep}`);
    if (!insideDocs) {
      response.statusCode = 400;
      response.end('Malformed documentation path');
      return;
    }

    const exists = fs.existsSync(candidate);
    const isDirectory = exists && fs.statSync(candidate).isDirectory();
    const directoryIndex = isDirectory ? path.join(candidate, 'index.html') : undefined;
    if (directoryIndex && fs.existsSync(directoryIndex)) {
      const directoryRequest = resolveDocumentationDirectory(requestUrl.pathname);
      if (directoryRequest.kind === 'redirect') {
        response.statusCode = 307;
        response.setHeader(
          'Location',
          `${directoryRequest.path}${requestUrl.search}${requestUrl.hash}`,
        );
        response.end();
        return;
      }
      // Vite's history fallback treats a directory URL as a React route even
      // when that directory contains index.html. Point its static middleware at
      // the concrete MkDocs file so `/docs/<line>/.../` cannot become the SPA.
      request.url = `${directoryRequest.path}${requestUrl.search}`;
      return next();
    }
    if (exists && !isDirectory) return next();

    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Documentation page not found');
  };
}

/**
 * Chunks each chunk is guaranteed to have loaded before any of its code runs: the
 * transitive closure of its STATIC imports (an ES module evaluates only after every
 * static dependency has loaded). Filled per build by {@link preloadClosurePlugin}.
 */
let staticClosureByChunk = new Map<string, Set<string>>();

/**
 * Records every chunk's static-import closure before Vite writes the dynamic-import
 * preload lists (`order: 'pre'` runs this hook ahead of Vite's own import analysis).
 */
function preloadClosurePlugin(): Plugin {
  return {
    name: 'tlsoc-preload-closure',
    apply: 'build',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        const imports = new Map<string, string[]>();
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') imports.set(output.fileName, output.imports);
        }
        const next = new Map<string, Set<string>>();
        for (const [fileName, direct] of imports) {
          const seen = new Set<string>();
          const visit = (name: string) => {
            if (seen.has(name)) return;
            seen.add(name);
            for (const dep of imports.get(name) ?? []) visit(dep);
          };
          direct.forEach(visit);
          next.set(fileName, seen);
        }
        staticClosureByChunk = next;
      },
    },
  };
}

/**
 * Trim each dynamic import's preload list to chunks that can still be missing. Vite lists
 * the imported chunk's whole static graph, including the vendor chunks its importer has
 * already loaded; in the entry that is every `React.lazy` page naming react-vendor,
 * radix, icons and utils again, which the browser already holds (they are the entry's
 * own static imports and index.html modulepreloads). Dropping them changes nothing at
 * runtime and keeps the first-paint entry inside the chat revamp's 1 kB budget
 * (SPEC §10.10). A list left holding only the imported chunk itself becomes `[]`, the
 * same rule Vite applies (preloading the module `import()` fetches next is a no-op).
 * Without a recorded closure (an unexpected hook order) the list is kept as Vite built it.
 */
function resolvePreloadDependencies(
  filename: string,
  deps: string[],
  context: { hostId: string; hostType: 'html' | 'js' },
): string[] {
  if (context.hostType !== 'js') return deps;
  const loaded = staticClosureByChunk.get(context.hostId);
  if (!loaded) return deps;
  const kept = deps.filter((dep) => !loaded.has(dep));
  return kept.length === 1 && kept[0] === filename ? [] : kept;
}

function bundledDocumentationPlugin(): Plugin {
  return {
    name: 'tlsoc-bundled-documentation',
    configureServer(server) {
      server.middlewares.use(docsRequestBoundary(DEV_DOCS_ROOT));
    },
    configurePreviewServer(server) {
      server.middlewares.use(docsRequestBoundary(PREVIEW_DOCS_ROOT));
    },
  };
}

export default defineConfig({
  plugins: [releaseManifestPlugin(), bundledDocumentationPlugin(), preloadClosurePlugin(), react()],
  define: {
    __TLSOC_RELEASE_IDENTITY__: JSON.stringify(RELEASE_IDENTITY),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
    modulePreload: { resolveDependencies: resolvePreloadDependencies },
    rollupOptions: {
      output: {
        /**
         * Split heavy vendor libraries into their own long-lived, cacheable
         * chunks (Wave 0, foundation #6). Pairs with the per-page React.lazy
         * splits in App.tsx so the entry bundle no longer carries every page +
         * every vendor. Each entry returns a stable chunk name; anything else
         * falls through to Vite's default chunking.
         */
        manualChunks(id: string) {
          // App modules (src/) are never grouped here: Rollup pulls a manual chunk's
          // static dependencies into it, so grouping e.g. the shared chat modules moved
          // lib/api, registry and nav into that chunk and made the entry import it
          // statically (measured during the chat revamp). Preload-list size is trimmed
          // by `resolvePreloadDependencies` instead.
          if (!id.includes('node_modules')) return undefined;
          // clsx / tailwind-merge back the entry's cn() helper AND are a transitive
          // dependency of recharts. They MUST get their own tiny, stable chunk
          // BEFORE the recharts branch — otherwise Rollup co-locates clsx into the
          // recharts chunk, and the eager cn() then statically imports recharts,
          // dragging all 422 KB onto first paint. Splitting them out keeps recharts
          // reachable ONLY through the React.lazy chart pages.
          if (/[\\/]node_modules[\\/](clsx|tailwind-merge)[\\/]/.test(id))
            return 'utils';
          // recharts pulls in d3-* — keep it isolated so chart-heavy pages pay
          // for it only when they load.
          if (/[\\/]node_modules[\\/](recharts|d3-|victory-vendor|internmap|decimal\.js-light)/.test(id))
            return 'recharts';
          // motion.dev (the framer-motion successor, npm package `motion`) — route it
          // into its own lazy `motion` chunk. Match the package's OWN node_modules path
          // (not a loose `id.includes('motion')`, which would also catch unrelated
          // paths). The bundle-first-paint test asserts this chunk is emitted but is
          // NEVER modulepreloaded / statically imported by the entry (motion lives behind
          // the lazy `soc/components/motion/*` boundary).
          if (/[\\/]node_modules[\\/]motion[\\/]/.test(id)) return 'motion';
          if (id.includes('lucide-react')) return 'icons';
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) return 'radix';
          // react / react-dom (and the JSX runtime / scheduler) form the core.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|object-assign|use-sync-external-store)[\\/]/.test(id))
            return 'react-vendor';
          return undefined;
        },
      },
    },
  },
});
