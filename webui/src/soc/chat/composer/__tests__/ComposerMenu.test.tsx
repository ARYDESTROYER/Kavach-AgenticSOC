/**
 * ComposerMenu (Round 13, SPEC-chat T22): one icon per group heading (not one glyph per
 * row), each row its label with the description on a second line that wraps (never
 * truncated or pushed to the far edge; a saved prompt's long text shows two lines), and
 * group headings that stay in view while the list scrolls.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposerMenu, keepOptionInView } from '../ComposerMenu';
import { atMenuGroups, parseAtQuery, parseSlashQuery, slashMenuGroups } from '../commands';
import { makeContext } from './fixtures';
import { Harness, makeSpies, stubServer } from './harness';

function renderMenu(kind: 'slash' | 'at', groups: ReturnType<typeof slashMenuGroups>) {
  return render(
    <ComposerMenu kind={kind} groups={groups} active={groups[0]?.items[0]?.value ?? ''} onActiveChange={vi.fn()} onChoose={vi.fn()} />,
  );
}

describe('ComposerMenu', () => {
  it('puts one icon on each group heading and none on the rows', () => {
    const prompts = [{ id: 'p1', title: 'VPN anomalies', text: 'Any odd VPN logins this week?' }];
    const groups = slashMenuGroups(parseSlashQuery('/')!, makeContext(), prompts);
    const { container } = renderMenu('slash', groups);
    const headings = Array.from(container.querySelectorAll('[cmdk-group-heading]'));
    expect(headings.map((h) => h.textContent)).toEqual(groups.map((g) => g.heading));
    for (const heading of headings) expect(heading.querySelectorAll('svg')).toHaveLength(1);
    for (const option of screen.getAllByRole('option')) expect(option.querySelector('svg')).toBeNull();
  });

  it('keeps headings in view while the list scrolls (the group does not clip them)', () => {
    const { container } = renderMenu('slash', slashMenuGroups(parseSlashQuery('/')!, makeContext(), []));
    const group = container.querySelector('[cmdk-group]') as HTMLElement;
    expect(group.className).toContain('[&_[cmdk-group-heading]]:sticky');
    expect(group.className).toContain('[&_[cmdk-group-heading]]:top-0');
    expect(group.className).toContain('[&_[cmdk-group-heading]]:bg-popover');
    expect(group).toHaveClass('overflow-visible');
    expect(group).not.toHaveClass('overflow-hidden');
  });

  it('shows each row as its label over a wrapping description', () => {
    renderMenu('slash', slashMenuGroups(parseSlashQuery('/po')!, makeContext(), []));
    const posture = screen.getByRole('option', { name: /\/posture/ });
    const [label, hint] = Array.from(posture.children) as HTMLElement[];
    expect(label).toHaveTextContent('/posture');
    expect(label).toHaveClass('text-sm', 'font-mono');
    expect(hint).toHaveTextContent('How the SOC is doing right now');
    expect(hint).toHaveClass('text-xs', 'text-muted-foreground', 'break-words');
    expect(hint.className).not.toMatch(/\btruncate\b|ml-auto/);
    expect(posture).toHaveClass('flex-col');
  });

  it('shows at most two lines of a saved prompt\'s own long text', () => {
    const long = 'Find every sign-in from a new country this week, '.repeat(8);
    renderMenu('slash', slashMenuGroups(parseSlashQuery('/new')!, makeContext(), [{ id: 'p1', title: 'New countries', text: long }]));
    const row = screen.getByRole('option', { name: /New countries/ });
    expect(within(row).getByText(long.trim(), { exact: false })).toHaveClass('line-clamp-2');
  });

  it('describes a ready-made prompt in short console copy, not its full text clamped', () => {
    renderMenu('slash', slashMenuGroups(parseSlashQuery('/hunt')!, makeContext(), []));
    const row = screen.getByRole('option', { name: /Hunt an indicator/ });
    const hint = within(row).getByText('Hunt · Asks for Indicator, Period');
    expect(hint).not.toHaveClass('line-clamp-2');
    expect(row).not.toHaveTextContent(/across logs, cases and threat intel/);
  });

  it('describes a denied @-scope with the permission sentence', () => {
    const context = makeContext({}, { search_logs: 'sources:read', log_stats: 'sources:read' });
    renderMenu('at', atMenuGroups(parseAtQuery('@', 1)!, context, []));
    const logs = screen.getByRole('option', { name: /@logs/ });
    expect(logs).toHaveAttribute('aria-disabled', 'true');
    expect(logs).toHaveTextContent('Needs permission to read sources (sources:read)');
  });
});

describe('ComposerMenu keeps the highlighted row in view (T22, audit C5/C6)', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A 288 px list of 48 px rows under one 30 px sticky heading, laid out from the list's
   * own `scrollTop` (jsdom has no layout).
   */
  function layOut(list: HTMLElement) {
    let scrollTop = 0;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[cmdk-item]'));
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = Math.max(0, Math.min(v, 30 + rows.length * 48 - 288))) });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 288 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 30 + rows.length * 48 });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: Element) {
      const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
      if (this === list) return box(0, 288);
      if (this.hasAttribute('cmdk-group-heading')) return box(0, 30);
      const index = rows.indexOf(this as HTMLElement);
      if (index >= 0) return box(30 + index * 48 - scrollTop, 48);
      return box(0, 0);
    });
    return { rows, scrollTop: () => scrollTop };
  }

  it('scrolls the list when the arrow keys move the highlight past the fold, and back up', () => {
    const groups = slashMenuGroups(parseSlashQuery('/')!, makeContext(), []);
    const values = groups.flatMap((g) => g.items.map((item) => item.value));
    expect(values.length).toBeGreaterThan(6);
    const props = { kind: 'slash' as const, groups, onActiveChange: vi.fn(), onChoose: vi.fn() };
    const { rerender } = render(<ComposerMenu {...props} active={values[0]} />);
    const list = screen.getByRole('listbox');
    const { rows, scrollTop } = layOut(list);
    // The 7th row starts at 318 px: below the 288 px list.
    rerender(<ComposerMenu {...props} active={values[6]} />);
    const row = rows[6].getBoundingClientRect();
    expect(scrollTop()).toBeGreaterThan(0);
    // Inside the list's box and clear of the 24 px bottom fade.
    expect(row.top).toBeGreaterThanOrEqual(30);
    expect(row.bottom).toBeLessThanOrEqual(288 - 24);
    // Back to the first row (a wrap, or ArrowUp): it comes out from under the heading.
    rerender(<ComposerMenu {...props} active={values[0]} />);
    expect(scrollTop()).toBe(0);
    expect(rows[0].getBoundingClientRect().top).toBe(30);
  });

  it('never scrolls for a row the pointer highlights (a hover must not slide another row under the click)', () => {
    const groups = slashMenuGroups(parseSlashQuery('/')!, makeContext(), []);
    const values = groups.flatMap((g) => g.items.map((item) => item.value));
    let move: (value: string) => void = () => {};
    const onChoose = vi.fn();
    function Stateful() {
      const [active, setActive] = React.useState(values[0]);
      move = setActive;
      return <ComposerMenu kind="slash" groups={groups} active={active} onActiveChange={setActive} onChoose={onChoose} />;
    }
    render(<Stateful />);
    const list = screen.getByRole('listbox');
    const { rows, scrollTop } = layOut(list);
    // The 5th row runs from 222 to 270 px: its lower part sits under the 24 px bottom fade.
    fireEvent.pointerMove(rows[4]);
    expect(rows[4]).toHaveAttribute('aria-selected', 'true');
    expect(scrollTop()).toBe(0);
    // The click lands on the row that was pointed at.
    fireEvent.click(rows[4]);
    expect(onChoose).toHaveBeenCalledWith(groups.flatMap((g) => g.items)[4]);
    expect(scrollTop()).toBe(0);
    // A keyboard move past the fold still reveals its row.
    act(() => move(values[6]));
    expect(scrollTop()).toBeGreaterThan(0);
    expect(rows[6].getBoundingClientRect().bottom).toBeLessThanOrEqual(288 - 24);
    // Wheel back to the top, then the mouse moves inside the bottom band: no creep.
    list.scrollTop = 0;
    fireEvent.pointerMove(rows[5]);
    expect(rows[5]).toHaveAttribute('aria-selected', 'true');
    expect(scrollTop()).toBe(0);
    // The next keyboard move scrolls again (the pointer mark never sticks).
    act(() => move(values[7]));
    expect(scrollTop()).toBeGreaterThan(0);
  });

  it('in the composer: hovering a row under the fade keeps the list still; ArrowDown past the fold reveals', async () => {
    stubServer();
    const user = userEvent.setup();
    render(<Harness spies={makeSpies()} context={makeContext()} />);
    const textarea = screen.getByRole('textbox', { name: 'Message the assistant' });
    await user.type(textarea, '/');
    const list = await screen.findByRole('listbox', { name: 'Commands' });
    const { rows, scrollTop } = layOut(list);
    expect(rows.length).toBeGreaterThan(6);
    fireEvent.pointerMove(rows[4]);
    expect(rows[4]).toHaveAttribute('aria-selected', 'true');
    expect(textarea).toHaveAttribute('aria-activedescendant', rows[4].id);
    expect(scrollTop()).toBe(0);
    await user.keyboard('{ArrowDown}');
    expect(rows[5]).toHaveAttribute('aria-selected', 'true');
    expect(scrollTop()).toBeGreaterThan(0);
    const row = rows[5].getBoundingClientRect();
    expect(row.top).toBeGreaterThanOrEqual(30);
    expect(row.bottom).toBeLessThanOrEqual(288 - 24);
  });

  it('leaves a row that is already clear where it is, and lifts a row out from under the fade', () => {
    const list = document.createElement('div');
    const option = document.createElement('div');
    list.appendChild(option);
    let top = 0;
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = Math.min(Math.max(v, 0), 100)) });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 300 });
    const rect = (t: number, h: number) => ({ top: t, bottom: t + h, height: h }) as DOMRect;
    list.getBoundingClientRect = () => rect(0, 200);
    option.getBoundingClientRect = () => rect(40, 40);
    keepOptionInView(list, option);
    expect(top).toBe(0);
    // A row under the bottom fade scrolls until it clears the fade.
    option.getBoundingClientRect = () => rect(170 - top, 40);
    keepOptionInView(list, option);
    expect(top).toBe(34);
  });
});
