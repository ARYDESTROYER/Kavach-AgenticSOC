/**
 * Every layer the chat composer and thread shell open keeps a 16 px gap from the screen
 * edges (Round 13, SPEC-chat T23, audit C8): the `/` and `@` menu, Scope, the access
 * popover, the meter card, Options ⋯ and its submenus, the thread ⋯ menu and the history
 * row menus. Radix positions these in a real layout only, so this reads the sources:
 * each content element must pass `collisionPadding` of 16 (or the shared constant).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYER_EDGE_GAP } from '../ComposerOptions';

const CHAT = path.resolve(__dirname, '..', '..');
const FILES = [
  'composer/Composer.tsx',
  'composer/ScopeControls.tsx',
  'composer/AccessPopover.tsx',
  'composer/TokenMeter.tsx',
  'composer/ComposerOptions.tsx',
  'workspace/ThreadToolbar.tsx',
  'workspace/HistoryRail.tsx',
];
const TAGS = /<(PopoverContent|DropdownMenuContent|DropdownMenuSubContent)\b/g;

/** The opening tag starting at `start`: up to the first `>` outside `{…}`. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0 && source[i - 1] !== '=') return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe('chat layers keep the 16 px screen-edge gap', () => {
  it('uses 16 px as the shared gap', () => {
    expect(LAYER_EDGE_GAP).toBe(16);
  });

  for (const file of FILES) {
    it(`passes collisionPadding 16 on every layer in ${file}`, () => {
      const source = fs.readFileSync(path.join(CHAT, file), 'utf8');
      const tags = Array.from(source.matchAll(TAGS)).map((match) => openingTag(source, match.index ?? 0));
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) expect(tag).toMatch(/collisionPadding=\{(16|LAYER_EDGE_GAP)\}/);
    });
  }
});
