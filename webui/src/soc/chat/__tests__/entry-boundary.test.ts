/**
 * Entry-chunk boundary (SPEC §10.10): the chat data layer is lazy. No module that
 * ships in the first-paint bundle may STATICALLY import anything under `soc/chat/`
 * (a `React.lazy(() => import(...))` is fine), and the eager `api` object gains no
 * chat-stream, chat-context, conversation-search/pin or reports methods.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');

const EAGER_MODULES = [
  'main.tsx',
  'soc/App.tsx',
  'soc/AppShell.tsx',
  'soc/registry.tsx',
  'soc/router.tsx',
  'soc/nav.ts',
  'soc/nav-types.ts',
  'soc/components/CommandPalette.tsx',
  'soc/components/NavSidebar.tsx',
  'lib/api.ts',
  'lib/types.ts',
];

/** Static `import … from '…'` / `export … from '…'` / bare `import '…'` specifiers. */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(re)) out.push(match[1]);
  return out;
}

describe('chat entry-chunk boundary', () => {
  it('no eager module statically imports the lazy chat modules', () => {
    for (const rel of EAGER_MODULES) {
      const file = path.join(SRC, rel);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const chatImports = staticSpecifiers(source).filter(
        (specifier) => specifier.startsWith('@/soc/chat') || /(^|\/)chat\//.test(specifier),
      );
      // Type-only imports are erased at build time and cost no bytes.
      const runtime = chatImports.filter((specifier) => {
        const line = source.split('\n').find((l) => l.includes(`'${specifier}'`) || l.includes(`"${specifier}"`)) ?? '';
        return !/^\s*(?:import|export)\s+type\s/.test(line);
      });
      expect(runtime, rel).toEqual([]);
    }
  });

  it('the eager api object carries no chat revamp or reports endpoints', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib/api.ts'), 'utf8');
    for (const endpoint of ["'chat/stream'", "'chat/context'", 'chat/turns/', "'reports", '`reports/']) {
      expect(source, endpoint).not.toContain(endpoint);
    }
    // The data layer reaches the shared request path through these two exports.
    expect(source).toMatch(/export async function requestResponse\(/);
    expect(source).toMatch(/export async function request<T>\(/);
  });
});
