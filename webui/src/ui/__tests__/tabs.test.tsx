/**
 * ui/tabs — Round-7 W0.1. TabsContent fades in by default (Radix mounts only the active
 * panel, so this replays on tab-switch, not on every render); `animate={false}` opts a
 * panel out. Reduced motion is neutralised globally by the theme.css reset.
 */
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../tabs';

function renderTabs(animate?: boolean) {
  return render(
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">A</TabsTrigger>
      </TabsList>
      <TabsContent value="a" animate={animate}>
        Panel A
      </TabsContent>
    </Tabs>,
  );
}

describe('TabsContent fade', () => {
  it('fades in by default', () => {
    renderTabs();
    expect(screen.getByText('Panel A').className).toContain('animate-fade-in');
  });

  it('animate={false} opts the panel out of the fade', () => {
    renderTabs(false);
    expect(screen.getByText('Panel A').className).not.toContain('animate-fade-in');
  });

  it('still forwards a custom className', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a" className="space-y-4">
          Body
        </TabsContent>
      </Tabs>,
    );
    const el = screen.getByText('Body');
    expect(el.className).toContain('animate-fade-in');
    expect(el.className).toContain('space-y-4');
  });
});

describe('TabsList variants (Round 14, SPEC §4.9.2)', () => {
  function renderVariant(variant?: 'boxed' | 'underline') {
    return render(
      <Tabs defaultValue="a">
        <TabsList variant={variant} aria-label="Sections">
          <TabsTrigger value="a">
            <svg data-testid="glyph" aria-hidden />
            Overview
          </TabsTrigger>
          <TabsTrigger value="b">Runbook</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>,
    );
  }

  it('keeps the boxed rail as the default (in-module switches)', () => {
    renderVariant();
    const list = screen.getByRole('tablist', { name: 'Sections' });
    expect(list).toHaveAttribute('data-variant', 'boxed');
    expect(list).toHaveClass('rounded-md', 'border', 'p-0.5', 'h-9');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveClass('rounded-sm', 'data-[state=active]:bg-accent/70');
  });

  it('underline: a full-width hairline, 13px labels, no icons, a 2px primary rule on the selected tab', () => {
    renderVariant('underline');
    const list = screen.getByRole('tablist', { name: 'Sections' });
    expect(list).toHaveAttribute('data-variant', 'underline');
    expect(list).toHaveClass('border-b', 'border-border/70');
    expect(list).not.toHaveClass('rounded-md');
    const tab = screen.getByRole('tab', { name: 'Overview' });
    expect(tab).toHaveClass('text-sm', '[&>svg]:hidden');
    expect(tab).toHaveAttribute('data-state', 'active');
    // The selected state is the label colour AND the rule, never colour alone; the weight
    // does not change (a bolder label would nudge its neighbours on every switch).
    expect(tab).toHaveClass('data-[state=active]:text-foreground', 'font-medium');
    expect(tab.className).not.toMatch(/data-\[state=active\]:font-(semibold|bold)/);
  });

  it('underline: the selected rule is a 2px border, so forced colours keep it', () => {
    renderVariant('underline');
    const tab = screen.getByRole('tab', { name: 'Overview' });
    expect(tab).toHaveClass(
      'data-[state=active]:after:h-0',
      'data-[state=active]:after:border-b-2',
      'data-[state=active]:after:border-primary',
      // The rule spans the label, not the focus room around it.
      'data-[state=active]:after:inset-x-1.5',
    );
    // A background would be replaced by Canvas in forced colours and vanish.
    expect(tab.className).not.toMatch(/after:bg-/);
  });

  it('underline: each trigger has room for its focus ring, and the labels keep their place', () => {
    renderVariant('underline');
    const list = screen.getByRole('tablist', { name: 'Sections' });
    const tab = screen.getByRole('tab', { name: 'Overview' });
    // 6px of inner room, so the inset ring frames the label instead of touching its glyphs.
    expect(tab).toHaveClass('px-1.5', 'rounded-sm', 'focus-visible:ring-2', 'focus-visible:ring-inset');
    // The list reaches 6px past the column on each side, so the trigger's room sits inside
    // its scroll clip, with no padding of its own (the first label stays on the column
    // edge), and gaps 8px (labels stay 20px apart: 6 + 8 + 6).
    expect(list).toHaveClass('-mx-1.5', 'gap-2', 'w-[calc(100%+0.75rem)]', 'overflow-x-auto');
    expect(list.className).not.toMatch(/(^|\s)px-/);
  });

  it('underline tabs select on click', () => {
    renderVariant('underline');
    const second = screen.getByRole('tab', { name: 'Runbook' });
    fireEvent.mouseDown(second);
    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-selected', 'true');
  });

  it('underline tabs keep Radix keyboard semantics: arrows move focus and select', async () => {
    renderVariant('underline');
    const first = screen.getByRole('tab', { name: 'Overview' });
    const second = screen.getByRole('tab', { name: 'Runbook' });
    act(() => first.focus());
    expect(first).toHaveFocus();
    // Radix moves roving focus on the next task, and automatic activation selects on focus.
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Panel B')).toBeInTheDocument();
    fireEvent.keyDown(second, { key: 'Home' });
    await waitFor(() => expect(first).toHaveFocus());
    expect(first).toHaveAttribute('aria-selected', 'true');
  });
});
