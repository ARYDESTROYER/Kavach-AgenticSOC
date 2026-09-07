/**
 * Full-height Console surfaces use the dynamic viewport so browser toolbar expansion
 * does not push the entire shell or strand sticky controls beyond the visible area.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCES = [
  ['App.tsx'],
  ['AppShell.tsx'],
  ['components', 'NavSidebar.tsx'],
  ['pages', 'Login.tsx'],
  ['pages', 'casedetail', 'CollaborationPanel.tsx'],
  ['pages', 'casedetail', 'CaseChatPanel.tsx'],
  ['pages', 'Roles.tsx'],
  ['pages', 'Sources.tsx'],
];

describe('dynamic viewport shell contract', () => {
  it.each(SOURCES)('%s avoids fixed screen/100vh sizing', (...segments) => {
    const source = readFileSync(path.resolve(__dirname, '..', ...segments), 'utf8');

    expect(source).toContain('dvh');
    expect(source).not.toMatch(/\b(?:h|min-h|max-h)-screen\b/);
    expect(source).not.toContain('100vh');
  });

  it.each([
    ['shared Dialog', '..', '..', 'ui', 'dialog.tsx'],
    ['shared AlertDialog', '..', '..', 'ui', 'alert-dialog.tsx'],
    ['shared Sheet', '..', '..', 'ui', 'sheet.tsx'],
    ['expanded Noise Funnel', '..', 'components', 'NoiseFunnel.tsx'],
    // The KPI deep-inspection modal is a FIXED-height page-in-page (`h-[92dvh]`), so it is
    // exactly the kind of surface a stray `vh` would break: on mobile it would size to the
    // largest viewport and hide its own pinned footer behind the browser toolbar.
    ['KPI deep-inspection modal', '..', 'components', 'KpiDrilldownPanel.tsx'],
  ])('%s uses dynamic rather than legacy viewport units', (_label, ...segments) => {
    const source = readFileSync(path.resolve(__dirname, ...segments), 'utf8');

    expect(source).toContain('dvh');
    expect(source).not.toMatch(/\d+(?:\.\d+)?vh\b/);
    expect(source).not.toMatch(/\d+(?:\.\d+)?vw\b/);
  });

  it('keeps the expanded Noise Funnel width visual-viewport bounded', () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', 'components', 'NoiseFunnel.tsx'),
      'utf8',
    );
    expect(source).toContain('96dvw');
  });
});
