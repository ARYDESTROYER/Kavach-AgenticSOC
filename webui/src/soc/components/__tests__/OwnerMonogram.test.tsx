/**
 * OwnerMonogram — the one assignee monogram (Round 12 polish, screenshot tour 2 #4).
 *
 * The Case Manager queue, the case header and the Cases list each drew their own chip on
 * `bg-surface-sunken`, which in dark mode IS the panel colour: unselected queue rows showed
 * a bare "A" next to "Escalated" and the header a bare "S" before "sgupta". This pins:
 *   1. one shared component at every call site (no page-local chip on the panel colour);
 *   2. the disk and the letter, MEASURED from theme.css in both themes: disk ≥3:1 against
 *      the card, the page and a selected queue row; letter ≥4.5:1 on the disk;
 *   3. the accessible name "Assigned to <owner>", or hidden where the name is beside it;
 *   4. the initial is a letter or digit and the owner text is plain (UNTRUSTED, #9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  WEBUI_ROOT,
  contrastRatio,
  parseThemeCss,
  resolveTokenRgb,
  type Rgb,
} from '../../../../scripts/lib/theme-css.mjs';
import { OWNER_MONOGRAM_CLASS, OwnerMonogram, assignedToLabel, ownerInitial } from '../OwnerMonogram';

expect.extend(toHaveNoViolations);

describe('OwnerMonogram', () => {
  it('is a named image: "Assigned to <owner>", with the initial as its visible text', () => {
    render(<OwnerMonogram name="  sgupta " />);
    const disk = screen.getByRole('img', { name: 'Assigned to sgupta' });
    expect(disk).toHaveTextContent(/^S$/);
    expect(disk).toHaveAttribute('title', 'Assigned to sgupta');
  });

  it('is hidden from assistive tech when the visible name sits beside it', () => {
    render(
      <span>
        <OwnerMonogram name="pnair" decorative />
        pnair
      </span>,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('owner-monogram')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders nothing for an empty or blank owner', () => {
    const { container } = render(<OwnerMonogram name="   " />);
    expect(container).toBeEmptyDOMElement();
  });

  it('takes the first letter or digit and keeps owner text plain', () => {
    expect(ownerInitial('asmith')).toBe('A');
    expect(ownerInitial('_svc_bureau')).toBe('S');
    expect(ownerInitial('2nd-line')).toBe('2');
    expect(ownerInitial('élodie')).toBe('É');
    expect(ownerInitial('')).toBe('');
    render(<OwnerMonogram name={'<img src=x onerror=alert(1)>'} />);
    const disk = screen.getByRole('img', { name: 'Assigned to <img src=x onerror=alert(1)>' });
    expect(disk.querySelector('img')).toBeNull();
    expect(assignedToLabel(' dkumar ')).toBe('Assigned to dkumar');
  });

  it('has no axe violations in either form', async () => {
    const { container } = render(
      <div>
        <OwnerMonogram name="Admin" />
        <span>
          <OwnerMonogram name="Admin" decorative />
          Admin
        </span>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('OwnerMonogram colours (measured from theme.css)', () => {
  const { light, dark } = parseThemeCss();
  const themes = { light, dark: new Map<string, string>([...light, ...dark]) };
  const classes = OWNER_MONOGRAM_CLASS.split(/\s+/);
  const token = (prefix: string) => {
    const hit = classes.find((c) => c.startsWith(prefix) && /^[a-z-]+$/.test(c.slice(prefix.length)));
    expect(hit, `${prefix}* class`).toBeTruthy();
    return `--${hit!.slice(prefix.length)}`;
  };
  const fill = token('bg-');
  const letter = token('text-');
  const over = (top: Rgb, alpha: number, under: Rgb): Rgb =>
    top.map((c, i) => alpha * c + (1 - alpha) * under[i]) as Rgb;

  it('never paints the disk in a panel colour', () => {
    for (const panel of ['--surface-sunken', '--card', '--background', '--canvas', '--surface', '--muted']) {
      expect(fill).not.toBe(panel);
    }
    // The border is the fill's own colour: invisible normally, a ring under forced colours.
    expect(classes).toContain(`border-${fill.slice(2)}`);
  });

  it.each(Object.entries(themes))('%s: the disk stands out from every ground it sits on', (_name, map) => {
    const disk = resolveTokenRgb(fill, map)!;
    const card = resolveTokenRgb('--card', map)!;
    // The selected queue row: `bg-primary/[0.09]` light, `/[0.12]` dark, over the card.
    const selected = over(resolveTokenRgb('--primary', map)!, _name === 'dark' ? 0.12 : 0.09, card);
    for (const ground of [card, resolveTokenRgb('--background', map)!, resolveTokenRgb('--canvas', map)!, selected]) {
      expect(contrastRatio(disk, ground)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(Object.entries(themes))('%s: the letter clears AA on the disk', (_name, map) => {
    expect(contrastRatio(resolveTokenRgb(letter, map)!, resolveTokenRgb(fill, map)!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('one monogram at every call site', () => {
  const read = (rel: string) => fs.readFileSync(path.join(WEBUI_ROOT, 'src', rel), 'utf8');
  it.each([
    ['soc/pages/CaseManager.tsx'],
    ['soc/pages/Cases.tsx'],
    ['soc/pages/casedetail/CaseHeaderMeta.tsx'],
  ])('%s uses OwnerMonogram, not a page-local chip', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/<OwnerMonogram\b/);
    expect(src).not.toMatch(/rounded-full bg-surface-sunken/);
  });
});
