/**
 * The drill-down row identity fallbacks.
 *
 * Trimming AFTER a `||` chain is the wrong order: a whitespace-only earlier field is a
 * truthy string, so it wins the chain and then trims away to nothing -- discarding a
 * perfectly good later candidate and rendering a dash or "Untitled case" over real data.
 * These pin the trim-then-select order.
 */
import { describe, it, expect } from 'vitest';

import { firstNonBlank } from '../KpiDrilldownPanel';

describe('firstNonBlank', () => {
  it('skips a whitespace-only candidate and takes the next real one', () => {
    expect(firstNonBlank('   ', 'case-0042')).toBe('case-0042');
    expect(firstNonBlank('\t\n', '', '  sig-7  ')).toBe('sig-7');
  });

  it('prefers the first candidate when it actually carries a value', () => {
    expect(firstNonBlank(' C-1 ', 'case-0042')).toBe('C-1');
  });

  it('returns empty when every candidate is blank, absent or nullish', () => {
    expect(firstNonBlank('   ', '', null, undefined)).toBe('');
    expect(firstNonBlank()).toBe('');
  });
});
