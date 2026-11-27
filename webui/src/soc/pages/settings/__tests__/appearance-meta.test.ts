/**
 * The Appearance section's blurb and help say what it sets (WP16): the viewer's theme and
 * saved views, and for an administrator the organization terminology. It sets no
 * organization defaults: the default theme is set in Branding.
 */
import { describe, expect, it } from 'vitest';

import { SECTION_META_BY_ID } from '../settings-sections-meta';

describe('the Appearance section copy', () => {
  it('names the terminology only, not organization defaults', () => {
    const meta = SECTION_META_BY_ID.customization;
    expect(meta.title).toBe('Appearance');
    expect(meta.blurb).toBe('Your theme, saved views, and the organization terminology.');
    expect(meta.help).toBe(
      'Your theme and saved views. Administrators can also set the organization terminology here. The default theme is set in Branding.',
    );
    expect(`${meta.blurb} ${meta.help}`).not.toMatch(/defaults/);
    // Branding (section id `appearance`) owns the default theme.
    expect(SECTION_META_BY_ID.appearance.title).toBe('Branding');
    expect(SECTION_META_BY_ID.appearance.blurb).toContain('default theme');
  });
});
