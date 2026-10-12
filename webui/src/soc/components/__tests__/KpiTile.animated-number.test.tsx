/**
 * KpiTile ↔ AnimatedNumber wiring (motion #3 regression).
 *
 * BUG: `AnimatedNumber` (the motion.dev spring count-up) existed but was DEAD CODE — no
 * component imported it. This test locks two things so it can't silently un-wire or break
 * the bundle budget again:
 *   1. KpiTile actually renders the spring numeral for `countTo` — the CSS `<CountUp>`
 *      fallback shows the correct value immediately, then UPGRADES to the lazy
 *      AnimatedNumber once the motion chunk resolves.
 *   2. KpiTile reaches AnimatedNumber via a LAZY `import(` (React.lazy), never a static
 *      `from './motion/AnimatedNumber'` — so motion.dev stays off KpiTile's static import
 *      graph and off the eager first-paint chunk (see bundle-first-paint.test.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { KpiTile } from '../KpiTile';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KPI_TILE_SRC = path.resolve(HERE, '..', 'KpiTile.tsx');

describe('KpiTile — AnimatedNumber is wired in (no longer dead code)', () => {
  // Load the spring module (and motion.dev behind it) once, before the render test, so
  // the upgrade below waits on React.lazy only, never on how long a cold worker takes to
  // load motion.dev: that load used to outlast waitFor's one second on a busy machine. The
  // lazy import still resolves after first paint (a promise is never synchronous), so the
  // CountUp fallback is still what the first assertion reads.
  beforeAll(async () => {
    await import('../motion/AnimatedNumber');
  });


  it('renders the CountUp fallback immediately, then upgrades to the lazy AnimatedNumber', async () => {
    render(<KpiTile label="Open" value="0" countTo={7} />);

    // Suspense fallback: the CSS-rAF CountUp shows the correct number on first paint.
    expect(screen.getByTestId('count-up')).toHaveTextContent('7');
    expect(screen.queryByText('0')).toBeNull(); // countTo overrides `value`

    // Once the lazy motion chunk resolves, AnimatedNumber replaces the fallback (its span
    // carries no `count-up` testid), and the number stays correct through the upgrade.
    await waitFor(() => expect(screen.queryByTestId('count-up')).toBeNull());
    expect(screen.getByTestId('kpi-open')).toHaveTextContent('7');
  });

  it('imports AnimatedNumber LAZILY (a dynamic import, never a static import)', () => {
    const src = fs.readFileSync(KPI_TILE_SRC, 'utf8');
    // AnimatedNumber must be referenced (not dead) AND reached only via a lazy import().
    expect(src).toMatch(/import\(\s*['"]\.\/motion\/AnimatedNumber['"]\s*\)/);
    // A STATIC `from './motion/AnimatedNumber'` would drag motion.dev onto KpiTile's static
    // graph — forbidden. (Guards the lazy boundary the same way LazySparkline does.)
    expect(src).not.toMatch(/from\s*['"]\.\/motion\/AnimatedNumber['"]/);
    // And it must not import the motion.dev package directly here either.
    expect(src).not.toMatch(/from\s*['"]motion(?:\/[^'"]*)?['"]/);
  });
});
