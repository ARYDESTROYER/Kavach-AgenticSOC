/**
 * The light-theme token map the HTML export and the print portal carry must equal the
 * resolved `:root` entries of `styles/theme.css` (BLOCKS.md §7.3). Re-resolved with the
 * design gates' own parser, so a theme change fails here instead of drifting silently.
 */
import { describe, expect, it } from 'vitest';

// The gates' dependency-free theme parser (plain ESM, shared with `npm run gates`).
import { parseThemeCss, resolveToken } from '../../../../../scripts/lib/theme-css.mjs';
import { REPORT_LIGHT_TOKENS, tokenDeclarations, tokenStyle } from '../export/report-tokens';

describe('report light tokens', () => {
  it('equal the resolved :root values of theme.css', () => {
    const { light } = parseThemeCss() as { light: Map<string, string> };
    for (const [name, value] of Object.entries(REPORT_LIGHT_TOKENS)) {
      expect(resolveToken(name, light), `--${name}`).toBe(value);
    }
  });

  it('cover what the report renderers paint with', () => {
    for (const name of ['background', 'foreground', 'muted', 'muted-foreground', 'border', 'primary', 'chart-1', 'chart-8', 'critical', 'warning', 'info']) {
      expect(REPORT_LIGHT_TOKENS[name], name).toBeTruthy();
    }
  });

  it('serialise as CSS declarations and as a React custom-property style', () => {
    expect(tokenDeclarations()).toContain('--chart-1:211 100% 36%;');
    expect(tokenStyle()['--background']).toBe(REPORT_LIGHT_TOKENS.background);
  });
});
