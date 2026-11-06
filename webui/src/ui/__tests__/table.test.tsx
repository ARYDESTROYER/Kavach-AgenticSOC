/**
 * TableHeader — a sticky header is floating chrome and wears the ONE material
 * (`materialBar`: 0.97 fill + blur, solid under reduced transparency / increased
 * contrast), while the non-sticky default has no wash at all (Round 14, C7: column
 * labels sit on the surface the table sits on). The round-6 ui-theme #55 bug was an
 * unconditional `bg-surface/50` whose translucent rule won the cascade over the sticky
 * fill; that rule must still never ride on a sticky header. (Round 12: the sticky fill moved from a bespoke
 * `bg-surface` + blur to the shared material recipe.)
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Table, TableHeader, TableRow, TableHead } from '../table';

function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe('TableHeader — sticky background opacity', () => {
  it('sticky header wears the shared material (never the translucent bg-surface/50)', () => {
    const { container } = render(
      <Table>
        <TableHeader sticky>
          <TableRow>
            <TableHead>Col</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const thead = container.querySelector('thead')!;
    const tokens = classTokens(thead);
    expect(tokens).toContain('material-surface');
    expect(tokens).toContain('bg-background/[0.97]');
    expect(tokens).toContain('sticky');
    expect(tokens).not.toContain('bg-surface/50');
  });

  it('non-sticky header has no wash: the labels sit on the table\'s own surface (Round 14, C7)', () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Col</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const thead = container.querySelector('thead')!;
    const tokens = classTokens(thead);
    expect(tokens).not.toContain('bg-surface/50');
    expect(tokens.filter((t) => /^bg-/.test(t))).toEqual([]);
    expect(tokens).not.toContain('sticky');
  });
});
