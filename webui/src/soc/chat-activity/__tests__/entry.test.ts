/**
 * The bundle rule for the working indicator (Round 12, SPEC D13 / §6): only the store,
 * the glyph and the tiny base-title setter ride the first-paint graph. Everything else
 * (the writers, the wording, the shell effects, the prefix composer) is reached through
 * lazy chunks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');
const EAGER_HOSTS = ['soc/AppShell.tsx', 'soc/components/NavSidebar.tsx', 'soc/theme.tsx'];
const EAGER_CORE = ['soc/chat-activity/store.ts', 'soc/chat-activity/glyph.tsx', 'soc/chat-activity/document-title.ts'];
const ALLOWED = new Set(['store', 'glyph', 'document-title']);

/** Runtime static import specifiers (type-only imports are erased at build time). */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*import\s+(?!type\s)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(re)) out.push(match[1]);
  return out;
}

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('chat activity entry boundary', () => {
  it('eager hosts statically import only the store, the glyph and the base-title setter', () => {
    for (const rel of EAGER_HOSTS) {
      const activity = runtimeImports(read(rel)).filter((specifier) => specifier.includes('chat-activity/'));
      const modules = activity.map((specifier) => specifier.split('chat-activity/')[1]);
      expect(modules.filter((name) => !ALLOWED.has(name)), rel).toEqual([]);
    }
  });

  it('the eager core imports nothing but React, the class helper, its stylesheet and itself', () => {
    for (const rel of EAGER_CORE) {
      const imports = runtimeImports(read(rel));
      const foreign = imports.filter(
        (specifier) => !['react', '@/lib/cn', '@/styles/activity.css', './store'].includes(specifier),
      );
      expect(foreign, rel).toEqual([]);
    }
  });

  it('the shell reaches its effects only through a lazy import', () => {
    const shell = read('soc/AppShell.tsx');
    expect(shell).toContain("import('./chat-activity/ActivityEffects')");
    expect(runtimeImports(shell)).not.toContain('./chat-activity/ActivityEffects');
  });

  it('holds no literal invisible or bidi control characters in its sources (Trojan Source)', () => {
    const dir = path.join(SRC, 'soc/chat-activity');
    // Escapes (\u200b) are fine: only the raw characters are refused.
    const hidden = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f]|[\u{E0000}-\u{E0FFF}]/u;
    for (const name of fs.readdirSync(dir).filter((file) => /\.(ts|tsx|css)$/.test(file))) {
      expect(hidden.test(fs.readFileSync(path.join(dir, name), 'utf8')), name).toBe(false);
    }
  });
});
