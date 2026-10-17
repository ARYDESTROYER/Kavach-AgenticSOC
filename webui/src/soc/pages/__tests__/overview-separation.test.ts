/**
 * Round 13 TEMPORARY preview switch for the Overview card separation options.
 *
 * Two contracts: the switch reads `?separation=<id>` once (URL query or hash-route query)
 * and remembers it for the session, and the default page is untouched — every preview
 * rule in theme.css is scoped under `[data-ov-sep]`, which the Overview sets only while a
 * preview is selected.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { THEME_CSS_PATH } from '../../../../scripts/lib/theme-css.mjs';
import { ALLOWED_TOKENS } from '../../theme-tokens';
import {
  SEPARATION_IDS,
  SEPARATION_SESSION_KEY,
  parseSeparation,
  readSeparationPreview,
} from '../overview-separation';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => {
      data.delete(k);
    },
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
    },
  };
}

const loc = (search: string, hash = '#/overview') => ({ search, hash });

describe('parseSeparation', () => {
  it('accepts the four ids, their a..d aliases, the old raised name and the clear words', () => {
    for (const id of SEPARATION_IDS) expect(parseSeparation(id)).toBe(id);
    expect(parseSeparation('A')).toBe('grouped');
    expect(parseSeparation('b')).toBe('hairlines');
    expect(parseSeparation(' c ')).toBe('titled');
    expect(parseSeparation('d')).toBe('bordered');
    expect(parseSeparation('raised')).toBe('bordered');
    for (const word of ['current', 'none', 'off', 'default']) expect(parseSeparation(word)).toBe('clear');
  });

  it('ignores anything else', () => {
    for (const raw of [null, undefined, '', '   ', 'cards', 'e', 'grouped;x']) {
      expect(parseSeparation(raw)).toBeNull();
    }
  });
});

describe('readSeparationPreview', () => {
  it('renders today\'s look with no parameter and nothing remembered', () => {
    expect(readSeparationPreview(loc(''), memoryStorage())).toBeNull();
  });

  it('reads the URL query and remembers it for the session', () => {
    const storage = memoryStorage();
    expect(readSeparationPreview(loc('?separation=grouped'), storage)).toBe('grouped');
    expect(storage.getItem(SEPARATION_SESSION_KEY)).toBe('grouped');
    // A later visit without the parameter keeps the remembered choice.
    expect(readSeparationPreview(loc(''), storage)).toBe('grouped');
  });

  it('reads the hash route query too', () => {
    const storage = memoryStorage();
    expect(readSeparationPreview(loc('', '#/overview?separation=d'), storage)).toBe('bordered');
    expect(storage.getItem(SEPARATION_SESSION_KEY)).toBe('bordered');
  });

  it('a clear word forgets the remembered choice', () => {
    const storage = memoryStorage({ [SEPARATION_SESSION_KEY]: 'titled' });
    expect(readSeparationPreview(loc('?separation=current'), storage)).toBeNull();
    expect(storage.getItem(SEPARATION_SESSION_KEY)).toBeNull();
  });

  it('ignores an unknown stored value and survives storage that throws', () => {
    expect(readSeparationPreview(loc(''), memoryStorage({ [SEPARATION_SESSION_KEY]: 'nope' }))).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readSeparationPreview(loc('?separation=hairlines'), broken)).toBe('hairlines');
    expect(readSeparationPreview(loc(''), broken)).toBeNull();
  });
});

describe('theme.css preview block', () => {
  const css = fs.readFileSync(THEME_CSS_PATH, 'utf8');
  const start = css.indexOf('/* ---- Overview card separation: PREVIEW OPTIONS');
  const end = css.indexOf('/* ---- Printing a console page', start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');

  it('exists, before the console print rules', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('scopes every rule under [data-ov-sep], so the default Overview is untouched', () => {
    // Every selector list that opens a declaration block (not an at-rule).
    const selectors = Array.from(block.matchAll(/([^{};]+)\{/g))
      .map((m) => m[1].trim())
      .filter((sel) => sel && !sel.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(20);
    for (const list of selectors) {
      // Split the list on top-level commas only (`:is(a, b)` keeps its own commas).
      let depth = 0;
      let current = '';
      const parts: string[] = [];
      for (const ch of list) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          parts.push(current.trim());
          current = '';
        } else current += ch;
      }
      parts.push(current.trim());
      for (const sel of parts) expect(sel, sel).toMatch(/\[data-ov-sep/);
    }
  });

  it('adds no motion, no translucent material and no resting shadow', () => {
    expect(block).not.toMatch(/\b(transition|animation)\s*:/);
    expect(block).not.toMatch(/backdrop-filter/);
    expect(block).not.toMatch(/box-shadow\s*:/);
  });

  it('never redefines an operator-writable token, so a custom brand reaches every module', () => {
    expect(ALLOWED_TOKENS.has('--primary')).toBe(true);
    for (const token of ALLOWED_TOKENS) {
      expect(block, token).not.toMatch(new RegExp(`${token}\\s*:`));
    }
  });
});
