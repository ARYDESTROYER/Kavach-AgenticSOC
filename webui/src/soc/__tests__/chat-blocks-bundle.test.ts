/**
 * Source guards for the chat answer-blocks bundle (chat revamp SPEC §10.10).
 *
 * The blocks + charts kit is ONE lazy chunk. These guards read the SOURCE (no build
 * needed, so they always run) and fail on the three regressions that would silently
 * grow the transcript's download or the eager entry:
 *
 *   1. anything under `src/soc/chat/**` importing recharts, `components/charts.tsx` or
 *      `components/charts-soc.tsx` (each drags the ~420 kB recharts vendor chunk in);
 *   2. `MitreHeatmap` sliding back into `charts-soc.tsx` (it lives in its own
 *      recharts-free module, re-exported for existing callers);
 *   3. the eager shell (main / App / AppShell / registry / CommandPalette / NavSidebar)
 *      statically importing the blocks kit — it must be reached through `import()`;
 *   4. the Workspace ROUTE chunk (the rest of `src/soc/chat/**`, the Chat / Workspace
 *      pages and the Case Manager chat panel) statically importing the HEAVY half of the
 *      kit — `AnswerBlocks`, `BlockCard`, `charts/*`, `renderers/*` — which would fold
 *      every chart into the route chunk (SPEC §10.10: blocks and charts are their own
 *      lazy chunk). The light modules (`schema`, `context`, `format`, …) stay importable:
 *      the transcript needs `parseBlocks` and `citationAnchorId` eagerly.
 *
 * Plus G1 belt-and-braces with the ESLint rule: no `dangerouslySetInnerHTML` in
 * `src/soc/chat/**`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const CHAT = path.join(SRC, 'soc', 'chat');
const COMPONENTS = path.join(SRC, 'soc', 'components');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

/** Every module specifier a file imports (static `from`, side-effect, dynamic, re-export). */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

/** Only STATIC imports (a lazy `import()` is the allowed path into the kit). */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');
const BLOCKS = path.join(CHAT, 'blocks');

/** Resolve a specifier to a path under `src/` (relative or `@/`), else null (a package). */
function resolveSpecifier(from: string, spec: string): string | null {
  if (spec.startsWith('@/')) return path.join(SRC, spec.slice(2));
  if (spec.startsWith('.')) return path.resolve(path.dirname(from), spec);
  return null;
}

/** Is this resolved path one of the kit's HEAVY modules (the lazy chunk's content)? */
function isHeavyKitModule(resolved: string): boolean {
  const r = path.relative(BLOCKS, resolved).split(path.sep).join('/').replace(/\.(tsx?|jsx?)$/, '');
  if (r.startsWith('..') || path.isAbsolute(r)) return false;
  return /^(AnswerBlocks|BlockCard|BlockBoundary)$/.test(r) || /^(charts|renderers)(\/|$)/.test(r);
}
const FORBIDDEN = [/^recharts(\/|$)/, /(^|\/)components\/charts(\.tsx)?$/, /(^|\/)components\/charts-soc(\.tsx)?$/, /^\.\.?\/(\.\.\/)*charts(-soc)?$/];

describe('chat answer-blocks bundle guards', () => {
  const chatFiles = walk(CHAT).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`));

  it('finds the kit (the guard is not vacuous)', () => {
    expect(chatFiles.some((f) => f.endsWith(path.join('blocks', 'AnswerBlocks.tsx')))).toBe(true);
    expect(chatFiles.some((f) => f.endsWith(path.join('charts', 'CartesianChart.tsx')))).toBe(true);
  });

  it('never imports recharts, charts.tsx or charts-soc.tsx from src/soc/chat/**', () => {
    const offenders = chatFiles.flatMap((f) => {
      const specs = specifiers(fs.readFileSync(f, 'utf8'));
      return specs
        .filter((s) => FORBIDDEN.some((re) => re.test(s)) || /@\/soc\/components\/charts(-soc)?$/.test(s))
        .map((s) => `${rel(f)} → ${s}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps MitreHeatmap in its own recharts-free module, re-exported by charts-soc', () => {
    const mitre = fs.readFileSync(path.join(COMPONENTS, 'MitreHeatmap.tsx'), 'utf8');
    expect(specifiers(mitre).filter((s) => /recharts|charts-soc|\/charts$/.test(s))).toEqual([]);
    expect(mitre).toMatch(/export const MitreHeatmap\b/);
    const soc = fs.readFileSync(path.join(COMPONENTS, 'charts-soc.tsx'), 'utf8');
    expect(soc).toMatch(/export \{ MitreHeatmap \} from '\.\/MitreHeatmap'/);
    expect(soc).not.toMatch(/export const MitreHeatmap\b/);
  });

  it('imports MitreHeatmap from the extracted module inside the kit', () => {
    const users = chatFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('MitreHeatmap'));
    for (const f of users) {
      const specs = specifiers(fs.readFileSync(f, 'utf8')).filter((s) => /MitreHeatmap|charts-soc/.test(s));
      for (const s of specs) expect(s).toMatch(/components\/MitreHeatmap$/);
    }
  });

  it('is never imported statically by the eager shell', () => {
    const eager = [
      'main.tsx',
      'soc/App.tsx',
      'soc/AppShell.tsx',
      'soc/registry.tsx',
      'soc/components/CommandPalette.tsx',
      'soc/components/NavSidebar.tsx',
    ];
    const offenders = eager.flatMap((f) => {
      const full = path.join(SRC, f);
      if (!fs.existsSync(full)) return [];
      return staticSpecifiers(fs.readFileSync(full, 'utf8'))
        .filter((s) => /(^|\/)chat\/blocks(\/|$)/.test(s))
        .map((s) => `${f} → ${s}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the heavy kit out of the Workspace route chunk (static imports only through import())', () => {
    const routeFiles = [
      ...chatFiles.filter((f) => !f.startsWith(BLOCKS + path.sep)),
      ...['soc/pages/Chat.tsx', 'soc/pages/Workspace.tsx', 'soc/pages/casedetail/CaseChatPanel.tsx', 'soc/pages/casedetail/CaseChat.tsx'].map((f) => path.join(SRC, f)),
    ].filter((f) => fs.existsSync(f));
    const offenders = routeFiles.flatMap((f) =>
      staticSpecifiers(fs.readFileSync(f, 'utf8'))
        .filter((s) => {
          const resolved = resolveSpecifier(f, s);
          return resolved !== null && isHeavyKitModule(resolved);
        })
        .map((s) => `${rel(f)} → ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it('classifies the kit modules (the route guard is not vacuous)', () => {
    const page = path.join(SRC, 'soc', 'pages', 'Chat.tsx');
    expect(isHeavyKitModule(resolveSpecifier(page, '@/soc/chat/blocks/AnswerBlocks')!)).toBe(true);
    expect(isHeavyKitModule(resolveSpecifier(page, '../chat/blocks/charts/CartesianChart')!)).toBe(true);
    expect(isHeavyKitModule(resolveSpecifier(page, '@/soc/chat/blocks/renderers/TableView')!)).toBe(true);
    expect(isHeavyKitModule(resolveSpecifier(page, '@/soc/chat/blocks/schema')!)).toBe(false);
    expect(isHeavyKitModule(resolveSpecifier(page, '@/soc/chat/blocks/context')!)).toBe(false);
    expect(resolveSpecifier(page, 'react')).toBeNull();
  });

  it('never uses dangerouslySetInnerHTML anywhere in src/soc/chat/** (G1)', () => {
    // The attribute, prop, quoted-key and computed-key forms (`dangerouslySetInnerHTML={…}`,
    // `dangerouslySetInnerHTML: …`, `'dangerouslySetInnerHTML': …`, `['dangerouslySetInnerHTML']`);
    // a comment or sentence that NAMES the ban is fine.
    const BANNED = /dangerouslySetInnerHTML['"]?\s*[=:\]]/;
    expect(BANNED.test(`{ "dangerouslySetInnerHTML": x }`)).toBe(true);
    expect(BANNED.test(`p['dangerouslySetInnerHTML'] = x`)).toBe(true);
    expect(BANNED.test('no dangerouslySetInnerHTML, no HTML strings')).toBe(false);
    const offenders = chatFiles.filter((f) => BANNED.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('exports a default component from the lazy entry', () => {
    const entry = fs.readFileSync(path.join(CHAT, 'blocks', 'AnswerBlocks.tsx'), 'utf8');
    expect(entry).toMatch(/export default AnswerBlocks;/);
  });
});
