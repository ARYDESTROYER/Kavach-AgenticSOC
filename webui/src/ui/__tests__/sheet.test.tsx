/**
 * SheetHeader — reserves right padding (`pr-14`) so a long title never slides
 * underneath the built-in close (X) pinned at `right-4` (round-6 ui-theme #50),
 * removing the per-consumer `pr-8`/`truncate` workarounds.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../sheet';

describe('SheetHeader — reserves room for the close button', () => {
  it('applies pr-14 so titles do not underlap the X', () => {
    const { getByText } = render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>A very long sheet title that would otherwise reach the edge</SheetTitle>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    );
    const header = getByText(/A very long sheet title/).parentElement!;
    const tokens = header.className.split(/\s+/).filter(Boolean);
    expect(tokens).toContain('pr-14');
  });
});

/** The z-index a Tailwind class list sets (`z-10` -> 10), or null. */
function zIndexOf(className: string): number | null {
  const match = className.match(/(?:^|\s)z-(\d+)(?=\s|$)/);
  return match ? Number(match[1]) : null;
}

describe('Sheet close button above a sticky header (Round 14, defect F1)', () => {
  it('stacks the close button above the case detail header and renders it after that header', () => {
    // The case detail sheet pins its header (`relative z-10` on the material); without a
    // stacking class on the close button the header painted over it and took its clicks.
    const caseDetail = readFileSync(path.resolve(__dirname, '../../soc/pages/CaseDetail.tsx'), 'utf8');
    const headerBlock = caseDetail.slice(caseDetail.indexOf('data-testid="case-detail-header"'));
    const headerClass = headerBlock.slice(0, 400).match(/'relative (z-\d+)[^']*'/);
    expect(headerClass, 'the case detail header declares its stacking class').not.toBeNull();
    const headerZ = zIndexOf(headerClass![1]);
    expect(headerZ).not.toBeNull();

    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>CASE-000048</SheetTitle>
          <SheetDescription>Case detail</SheetDescription>
          <div data-testid="sticky-header" className={`relative ${headerClass![1]} shrink-0`}>
            header
          </div>
        </SheetContent>
      </Sheet>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const header = screen.getByTestId('sticky-header');
    const closeZ = zIndexOf(close.className);
    expect(closeZ).toBe(30);
    expect(closeZ!).toBeGreaterThan(headerZ!);
    // A sticky page band (`z-20`) inside a sheet stays below it too.
    expect(closeZ!).toBeGreaterThan(20);
    // Later in DOM order than the header, so it also wins a stacking tie and is the last
    // stop in the sheet's tab order.
    expect(header.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(close).toHaveClass('absolute', 'right-4', 'top-4');
  });
});

