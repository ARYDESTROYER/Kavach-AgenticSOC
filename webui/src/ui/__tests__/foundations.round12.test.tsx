/**
 * Round 12 primitive foundations (SPEC D16, SYNTHESIS-ux §1.3 / §1.6 / §1.8):
 *  - concentric radii: 10px menus/popovers holding 6px items; 14px dialogs and sheets
 *    (sheets on their leading edge only); 6px badges;
 *  - overlays scale FROM THEIR TRIGGER (Radix transform-origin variables);
 *  - elevation: menus `shadow-menu`, detached panels/dialogs/sheets `shadow-overlay`;
 *  - instant press feedback on buttons (97% in 100ms, motion-safe), never on links;
 *  - titles take their tracking from the size step (no `tracking-tight` override).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Badge } from '../badge';
import { Button, buttonVariants } from '../button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  dialogTransformOrigin,
} from '../dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { Sheet, SheetContent, SheetDescription, SheetTitle, sheetVariants } from '../sheet';
import { cn } from '@/lib/cn';

const tokens = (el: Element | string) =>
  (typeof el === 'string' ? el : el.className).split(/\s+/).filter(Boolean);

/**
 * Overlays scale FROM THEIR TRIGGER through one base rule in theme.css,
 * `[data-radix-popper-content-wrapper] > * { transform-origin:
 * var(--radix-popper-transform-origin) }` (no per-primitive class in the entry bundle).
 * The rule matches exactly when the content is the wrapper's direct child.
 */
function expectPopperOrigin(content: HTMLElement) {
  const wrapper = content.parentElement as HTMLElement;
  expect(wrapper).toHaveAttribute('data-radix-popper-content-wrapper');
  // No per-part origin class is needed (or wanted) on the content any more.
  expect(content.className).not.toMatch(/(^|\s)origin-\[var\(--radix-/);
}

describe('menus and popovers: concentric radii, trigger origin, elevation', () => {
  it('a dropdown menu is a 10px menu surface with 6px items that grows from its trigger', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menu = screen.getByRole('menu');
    expect(tokens(menu)).toEqual(expect.arrayContaining(['rounded-lg', 'p-1', 'bg-popover', 'shadow-menu']));
    // It grows from its trigger through ONE base rule (theme.css): Radix renders the
    // content as the direct child of the popper wrapper that carries the anchor origin.
    expectPopperOrigin(menu);
    expect(tokens(menu)).not.toContain('rounded-[3px]');
    const item = screen.getByRole('menuitem', { name: 'Rename' });
    expect(tokens(item)).toContain('rounded-sm');
  });

  it('a popover and a hover card are overlay surfaces anchored to their trigger', () => {
    render(
      <>
        <Popover defaultOpen>
          <PopoverTrigger>Usage</PopoverTrigger>
          <PopoverContent data-testid="popover">Details</PopoverContent>
        </Popover>
        <HoverCard defaultOpen>
          <HoverCardTrigger>Case</HoverCardTrigger>
          <HoverCardContent data-testid="hovercard">Preview</HoverCardContent>
        </HoverCard>
      </>,
    );
    const popover = screen.getByTestId('popover');
    expect(tokens(popover)).toEqual(expect.arrayContaining(['rounded-lg', 'shadow-overlay']));
    expectPopperOrigin(popover);
    const card = screen.getByTestId('hovercard');
    expect(tokens(card)).toEqual(expect.arrayContaining(['rounded-lg', 'shadow-overlay']));
    expectPopperOrigin(card);
    // The enter rides the critically damped spring; the exit stays a default fade.
    expect(tokens(popover)).toEqual(
      expect.arrayContaining(['data-[state=open]:duration-ui', 'data-[state=open]:ease-spring']),
    );
  });
});

describe('dialogs and sheets', () => {
  it('a dialog is 14px with overlay elevation and a spring enter', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Close case</DialogTitle>
          <DialogDescription>Pick a disposition.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(tokens(dialog)).toEqual(
      expect.arrayContaining([
        'rounded-xl',
        'shadow-overlay',
        'data-[state=open]:duration-ui',
        'data-[state=open]:ease-spring',
        'data-[state=closed]:duration-base',
      ]),
    );
    expect(tokens(dialog)).not.toContain('shadow-elev2');
    // Title tracking comes from the `lg` step, not a `tracking-tight` override.
    expect(tokens(screen.getByText('Close case'))).not.toContain('tracking-tight');
  });

  it('keeps the −50% centring inside the zoom keyframes (a zoom, not a diagonal slide)', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Centred</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(tokens(screen.getByRole('dialog'))).toEqual(
      expect.arrayContaining([
        'data-[state=open]:slide-in-from-left-1/2',
        'data-[state=open]:slide-in-from-top-1/2',
        'data-[state=closed]:slide-out-to-left-1/2',
        'data-[state=closed]:slide-out-to-top-1/2',
      ]),
    );
  });

  it('grows out of a caller-supplied point (a KPI tile) when one is given', () => {
    // No measurement: the centred panel's own box puts the point at 50% + (x − 50dvw).
    // Dynamic viewport units, like the panel's own max-height (viewport-units.test.ts).
    expect(dialogTransformOrigin({ x: 200.4, y: 150 })).toBe(
      'calc(50% + 200px - 50dvw) calc(50% + 150px - 50dvh)',
    );

    const { rerender } = render(
      <Dialog open>
        <DialogContent origin={{ x: 200, y: 150 }} style={{ maxWidth: '40rem' }}>
          <DialogTitle>Anchored</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.transformOrigin).toBe('calc(50% + 200px - 50dvw) calc(50% + 150px - 50dvh)');
    // A caller's own style survives alongside it.
    expect(dialog.style.maxWidth).toBe('40rem');
    // No point → the default centre (no inline origin).
    rerender(
      <Dialog open>
        <DialogContent origin={null}>
          <DialogTitle>Anchored</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').style.transformOrigin).toBe('');
  });

  it('a sheet rounds only its leading edge, from sm up, and enters on the pane spring', () => {
    expect(tokens(sheetVariants({ side: 'right' }))).toEqual(
      expect.arrayContaining(['sm:rounded-l-xl', 'data-[state=open]:duration-pane', 'shadow-overlay']),
    );
    expect(tokens(sheetVariants({ side: 'left' }))).toEqual(
      expect.arrayContaining(['sm:rounded-tr-xl', 'sm:rounded-br-xl']),
    );
    // Never the ambiguous `rounded-r-xl` (it collides with the `r-xl` radius token key).
    expect(sheetVariants({ side: 'left' })).not.toMatch(/(^|\s)(sm:)?rounded-r-xl(\s|$)/);
    // A full-width sheet has no leading edge to round (SheetContent merges with `cn`).
    const full = tokens(cn(sheetVariants({ side: 'right', size: 'full' })));
    expect(full).toContain('sm:rounded-none');
    expect(full).not.toContain('sm:rounded-l-xl');

    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Case</SheetTitle>
          <SheetDescription>Detail</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(tokens(screen.getByRole('dialog'))).toContain('bg-card');
    expect(tokens(screen.getByText('Case'))).not.toContain('tracking-tight');
  });

  it('a rounded side sheet clips its children to the radius', () => {
    // A full-bleed child with its own fill (the report panel's root in a `p-0` sheet)
    // would otherwise paint square corners over the 14px curve.
    for (const side of ['left', 'right'] as const) {
      expect(tokens(sheetVariants({ side }))).toContain('overflow-hidden');
    }
    // A consumer that scrolls the sheet itself keeps its vertical scroll: tailwind-merge
    // keeps `overflow-y-auto` beside the clip (CSS then scrolls y, clips x, and both
    // clip to the radius).
    const scrolling = tokens(cn(sheetVariants({ side: 'right' }), 'overflow-y-auto'));
    expect(scrolling).toEqual(expect.arrayContaining(['overflow-hidden', 'overflow-y-auto']));

    render(
      <Sheet defaultOpen>
        <SheetContent className="gap-0 p-0">
          <SheetTitle>Report</SheetTitle>
          <SheetDescription>Overlay</SheetDescription>
          <div className="flex h-full w-full bg-background">panel</div>
        </SheetContent>
      </Sheet>,
    );
    expect(tokens(screen.getByRole('dialog'))).toEqual(
      expect.arrayContaining(['overflow-hidden', 'sm:rounded-l-xl', 'p-0']),
    );
  });
});

describe('press feedback and small radii', () => {
  it('buttons settle to 97% on press in 100ms, motion-safe only', () => {
    const cls = tokens(buttonVariants({ variant: 'default' }));
    expect(cls).toEqual(
      expect.arrayContaining(['motion-safe:active:scale-[0.97]', 'duration-press', 'ease-out']),
    );
    // `transition` (Tailwind's default property list) covers the transform as well as
    // the colour change.
    expect(cls).toContain('transition');
    expect(cls).not.toContain('transition-colors');
    expect(cls).not.toContain('active:scale-[0.97]');
  });

  it('a full-width (row-shaped) button darkens on press instead of scaling', () => {
    // The override is on the BASE, so every variant and every full-width call site gets
    // it without opting in; it is stronger than the motion-safe scale (class + class +
    // :active), and it leaves the variant's own `active:` fill as the feedback.
    for (const variant of ['default', 'secondary', 'outline', 'ghost', 'destructive'] as const) {
      const cls = tokens(buttonVariants({ variant, className: 'h-11 w-full' }));
      expect(cls).toEqual(expect.arrayContaining(['[&.w-full]:active:scale-100', 'w-full']));
      expect(cls.some((c) => /^active:bg-/.test(c))).toBe(true);
    }
    render(
      <Button className="h-11 w-full justify-between" data-testid="row">
        Appearance
      </Button>,
    );
    expect(tokens(screen.getByTestId('row'))).toEqual(
      expect.arrayContaining(['w-full', '[&.w-full]:active:scale-100', 'motion-safe:active:scale-[0.97]']),
    );
  });

  it('a link-styled button never scales', () => {
    render(<Button variant="link">Open in Cases</Button>);
    const link = screen.getByRole('button', { name: 'Open in Cases' });
    expect(tokens(link)).toContain('motion-safe:active:scale-100');
    expect(tokens(link)).not.toContain('motion-safe:active:scale-[0.97]');
  });

  it('badges are 6px chips', () => {
    render(<Badge>Escalated</Badge>);
    expect(tokens(screen.getByText('Escalated'))).toContain('rounded-sm');
  });
});
