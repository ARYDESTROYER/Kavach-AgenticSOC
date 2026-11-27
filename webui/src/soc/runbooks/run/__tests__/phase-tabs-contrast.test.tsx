/**
 * The phase tabs' caption ink (WP16 browser checks, check 8): the selected tab's caption
 * ("3/3 · Complete") sits on the selected fill, `--accent`, which the case page's grouped
 * panel re-points to `--panel-accent`. Muted text there measured 4.22:1 in light, below
 * 4.5:1 for 12px text (axe `color-contrast`, serious). The selected tab raises the caption
 * to the foreground ink.
 *
 * The test reads the ink each caption really paints (its own colour utility, the selected
 * variant on the tab, or a remap of `--muted-foreground` on the tab) and measures it from
 * `theme.css` on the fills each tab state sits on, in both themes.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { contrastRatio, parseThemeCss, resolveTokenRgb } from '../../../../../scripts/lib/theme-css.mjs';
import { TooltipProvider } from '@/ui/tooltip';

import { RunbookRunProvider } from '../context';
import { PhaseTabs } from '../PhaseTabs';
import { makeData, makeRun } from './fixtures';

const AA_TEXT = 4.5;
const ACTIVE = 'group-data-[state=active]:';
const TRIGGER_ACTIVE = 'data-[state=active]:';
const MUTED_REMAP = /^\[--muted-foreground:var\((--[a-z-]+)\)\]$/;

const { light, dark } = parseThemeCss();
const THEMES = [
  ['light', light],
  ['dark', dark],
] as const;

/** A colour utility (`text-<token>` whose token is a theme colour), else null. */
function colourToken(cls: string): string | null {
  if (!cls.startsWith('text-')) return null;
  const token = `--${cls.slice(5)}`;
  return resolveTokenRgb(token, light) ? token : null;
}

/**
 * The token a caption's text paints with, honouring the tab's state: a caption utility
 * keyed on the selected tab (`group-data-[state=active]:text-*`), a plain one, the
 * colour inherited from the tab, and a remap of `--muted-foreground` the selected tab
 * carries (`data-[state=active]:[--muted-foreground:var(--foreground)]`).
 */
function captionInk(caption: HTMLElement, trigger: HTMLElement): string {
  const selected = trigger.getAttribute('data-state') === 'active';
  let ink: string | null = null;
  for (let node: HTMLElement | null = caption; node && !ink; node = node.parentElement) {
    const classes = Array.from(node.classList);
    if (selected && node !== trigger && trigger.classList.contains('group')) {
      for (const cls of classes) if (cls.startsWith(ACTIVE)) ink ??= colourToken(cls.slice(ACTIVE.length));
    }
    if (selected && node === trigger) {
      for (const cls of classes) if (cls.startsWith(TRIGGER_ACTIVE)) ink ??= colourToken(cls.slice(TRIGGER_ACTIVE.length));
    }
    for (const cls of classes) ink ??= colourToken(cls);
    if (node === trigger) break;
  }
  if (!ink) throw new Error('The caption paints no theme colour.');
  if (ink === '--muted-foreground' && selected) {
    for (const cls of Array.from(trigger.classList)) {
      if (!cls.startsWith(TRIGGER_ACTIVE)) continue;
      const remap = MUTED_REMAP.exec(cls.slice(TRIGGER_ACTIVE.length));
      if (remap) ink = remap[1];
    }
  }
  return ink;
}

function renderTabs() {
  const run = makeRun();
  return render(
    <TooltipProvider>
      <RunbookRunProvider
        caseId="case-1"
        caseLabel="CASE-000041"
        data={makeData([run])}
        run={run}
        canRun
        hasPermission={() => true}
        applyUpdate={vi.fn()}
        announce={vi.fn()}
      >
        <PhaseTabs phase="triage" onPhaseChange={vi.fn()} narrow={false} />
      </RunbookRunProvider>
    </TooltipProvider>,
  );
}

/** The element that holds the caption's words (the node axe measured). */
function captionOf(trigger: HTMLElement): HTMLElement {
  const caption = Array.from(trigger.querySelectorAll<HTMLElement>('span')).find(
    (el) => /^\d+\/\d+ · /.test(el.textContent ?? '') && el.childElementCount === 0,
  );
  if (!caption) throw new Error('No caption on the phase tab.');
  return caption;
}

describe('phase tab captions clear 4.5:1 on the fill under them', () => {
  it('raises the selected tab caption to an ink that clears 4.5:1 on both selected fills', () => {
    renderTabs();
    const selected = screen.getAllByRole('tab').find((t) => t.getAttribute('data-state') === 'active');
    expect(selected).toBeDefined();
    expect(captionOf(selected!).textContent).toMatch(/^2\/2 · /);
    const ink = captionInk(captionOf(selected!), selected!);
    for (const [theme, map] of THEMES) {
      for (const fill of ['--accent', '--panel-accent']) {
        const ratio = contrastRatio(resolveTokenRgb(ink, map)!, resolveTokenRgb(fill, map)!);
        expect(ratio, `${theme} ${ink} on ${fill}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps the muted caption on the tabs at rest, which clears 4.5:1 on the card and the panel', () => {
    renderTabs();
    const resting = screen.getAllByRole('tab').filter((t) => t.getAttribute('data-state') !== 'active');
    expect(resting.length).toBe(2);
    for (const tab of resting) {
      const ink = captionInk(captionOf(tab), tab);
      expect(ink).toBe('--muted-foreground');
      for (const [theme, map] of THEMES) {
        for (const ground of ['--card', '--panel']) {
          const ratio = contrastRatio(resolveTokenRgb(ink, map)!, resolveTokenRgb(ground, map)!);
          expect(ratio, `${theme} ${ink} on ${ground}`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
  });
});
