/**
 * Settings grouped panels (Round 14, SPEC §4.9.6, operator choice C9 option A):
 * `SettingsSection` (title row only, 44rem forms, room for the save bar),
 * `SettingsGroup` (title and caption above one tinted panel of hairline-divided rows)
 * and `SettingRow` (switch, select, field, status, action and link rows), plus the
 * `StickySaveBar` width that keeps the save bar under the section it saves, and `NumPref`
 * on the shared NumberField (never snapping a value, never rewriting one on focus alone).
 * In a full-width section a labelled control row still spans the panel but caps its
 * content at a form row's content width, so the control sits as near its label as in a
 * 44rem form section; form rows render exactly as they did before that cap existed.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  NumPref,
  SectionTitle,
  SettingRow,
  SettingsGroup,
  SettingsPageSection,
  SettingsSection,
  SettingsSectionContext,
  TextPref,
  type SettingRowProps,
} from '../primitives';
import {
  SETTINGS_FORM_MAX_WIDTH,
  SETTINGS_ROW_CONTENT_MAX_WIDTH,
  StickySaveBar,
} from '@/soc/components/SettingsGrid';
import { RouterProvider, useNavigationBlocker } from '@/soc/router';
import { StatusDot } from '@/design-system';
import { Button } from '@/ui/button';

expect.extend(toHaveNoViolations);

function chatAssistant(props: Partial<React.ComponentProps<typeof SettingsSection>> = {}) {
  const onSwitch = vi.fn();
  const onMode = vi.fn();
  const onLookups = vi.fn();
  const utils = render(
    <SettingsSection title="Chat assistant" help="How the read-only assistant answers in chat." {...props}>
      <SettingsGroup title="Spending" caption="Chat is outside the daily AI budget.">
        <SettingRow
          variant="switch"
          label="Daily chat spending limit"
          help="Off by default."
          checked={false}
          onCheckedChange={onSwitch}
        />
        <SettingRow
          variant="select"
          label="Typed-out answers"
          help="Answers arrive whole until a viewer turns this on."
          value="allowed_off"
          onValueChange={onMode}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'allowed_off', label: 'Allowed (off by default)' },
          ]}
        />
      </SettingsGroup>
      <SettingsGroup title="Timeouts and capacity">
        <SettingRow variant="field">
          <NumPref label="Lookups at once" help="Run side by side in one step." value={4} min={1} max={24} onChange={onLookups} />
        </SettingRow>
        <SettingRow variant="field" wide mono>
          <TextPref label="Evidence fields" help="Dotted paths." value="event.action" onChange={() => {}} />
        </SettingRow>
        <SettingRow
          variant="status"
          label="Two-factor authentication"
          status={<StatusDot>Off</StatusDot>}
          action={<Button size="sm">Turn on</Button>}
        />
        <SettingRow variant="action" label="Re-run setup" action={<Button size="sm">Open wizard</Button>} />
        <SettingRow variant="link" label="Connected sources" help="SIEM, EDR and queues." href="#/sources" value="5 of 5 enabled" />
      </SettingsGroup>
    </SettingsSection>,
  );
  return { ...utils, onSwitch, onMode, onLookups };
}

describe('SettingsSection', () => {
  it('is a region named by its h2 with the help tip beside the title and nothing else above the settings', () => {
    const { container } = chatAssistant({ actions: <Button size="sm">Refresh</Button> });
    const region = screen.getByRole('region', { name: 'Chat assistant' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Chat assistant' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'About Chat assistant' })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    // No description line, no "Modified" text.
    expect(container.textContent).not.toMatch(/How the read-only assistant/);
    expect(container.textContent).not.toMatch(/Modified|No unsaved changes/);
    // A form section is capped at 44rem; groups sit 40px apart.
    expect(region).toHaveClass('max-w-[44rem]');
    expect(region.querySelector('[data-settings-section-title]')?.nextElementSibling).toHaveClass('space-y-10');
  });

  it('takes the full width for a table section and keeps room for the save bar while modified', () => {
    const { rerender } = render(
      <SettingsSection title="Users" width="full">
        <p>table</p>
      </SettingsSection>,
    );
    const region = screen.getByRole('region', { name: 'Users' });
    expect(region).toHaveClass('max-w-none');
    expect(region).not.toHaveClass('pb-[72px]');
    rerender(
      <SettingsSectionContext.Provider value={{ modified: true }}>
        <SettingsSection title="Users" width="full">
          <p>table</p>
        </SettingsSection>
      </SettingsSectionContext.Provider>,
    );
    expect(screen.getByRole('region', { name: 'Users' })).toHaveClass('pb-[72px]');
  });

  it('shows no Ask about this outside the app router (the action needs a signed-in chat user)', () => {
    render(
      <SettingsSectionContext.Provider value={{ askTopic: 'settings:chat_agent' }}>
        <SettingsSection title="Chat assistant">
          <p>rows</p>
        </SettingsSection>
      </SettingsSectionContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: /Ask about this/ })).toBeNull();
  });
});

describe('SettingsGroup', () => {
  it('puts its title and caption above one tinted panel of hairline-divided rows', () => {
    chatAssistant();
    // A labelled group, never a region landmark: the section is the one region (SPEC §3.3).
    const group = screen.getByRole('group', { name: 'Spending' });
    expect(screen.queryByRole('region', { name: 'Spending' })).toBeNull();
    expect(within(group).getByRole('heading', { level: 3, name: 'Spending' })).toHaveClass('text-md', 'font-semibold');
    expect(within(group).getByText('Chat is outside the daily AI budget.')).toBeInTheDocument();
    const panel = group.querySelector('[data-settings-panel]')!;
    expect(panel).toHaveClass('surface-panel', 'divide-y');
    expect(panel.querySelectorAll('[data-setting-row]')).toHaveLength(2);
    // The title sits on the rows' inset.
    expect(group.firstElementChild).toHaveClass('px-4', 'xl:px-5');
  });
});

describe('SettingRow', () => {
  it('a switch row: the label names the switch and the help describes it', () => {
    const { onSwitch } = chatAssistant();
    const toggle = screen.getByRole('switch', { name: 'Daily chat spending limit' });
    expect(toggle).toHaveAccessibleDescription('Off by default.');
    fireEvent.click(toggle);
    expect(onSwitch).toHaveBeenCalledWith(true);
  });

  it('a select row: a combobox named by the row label and described by its help', () => {
    chatAssistant();
    const select = screen.getByRole('combobox', { name: 'Typed-out answers' });
    expect(select).toHaveAccessibleDescription('Answers arrive whole until a viewer turns this on.');
    expect(select.closest('[data-field-layout]')).toHaveAttribute('data-field-layout', 'inline');
  });

  it('a field row lays its Field-based control out inline; a wide row keeps it under the label', () => {
    const { onLookups } = chatAssistant();
    const lookups = screen.getByLabelText('Lookups at once');
    expect(lookups.closest('[data-field-layout]')).toHaveAttribute('data-field-layout', 'inline');
    expect(lookups.closest('[data-number-field]')).toHaveAttribute('data-number-field', 'sm');
    fireEvent.focus(lookups);
    fireEvent.change(lookups, { target: { value: '8' } });
    fireEvent.blur(lookups);
    expect(onLookups).toHaveBeenCalledWith(8);
    const evidence = screen.getByLabelText('Evidence fields');
    expect(evidence.closest('[data-field-layout]')).toHaveAttribute('data-field-layout', 'wide');
    // Identifiers read as code.
    expect(evidence.closest('[data-setting-row="field"]')?.className).toContain('[&_input]:font-mono');
  });

  it('a wide row reads like every other row: 14px label, 13px help, then the control at full width', () => {
    chatAssistant();
    const evidence = screen.getByLabelText('Evidence fields');
    const field = evidence.closest('[data-field-layout="wide"]') as HTMLElement;
    const label = within(field).getByText('Evidence fields');
    const help = within(field).getByText('Dotted paths.');
    expect(label).toHaveClass('text-base', 'leading-5');
    expect(help).toHaveClass('text-sm', 'text-muted-foreground', 'max-w-[42rem]');
    // Reading order: label, help, control.
    expect(label.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(evidence).toHaveAccessibleDescription('Dotted paths.');
  });

  it('a status row says the state in words and keeps its action', () => {
    chatAssistant();
    const row = screen.getByText('Two-factor authentication').closest('[data-setting-row]')!;
    expect(row).toHaveAttribute('data-setting-row', 'status');
    expect(within(row as HTMLElement).getByText('Off')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
  });

  it('a link row is one link to the other page, with its value', () => {
    chatAssistant();
    const link = screen.getByRole('link', { name: /Connected sources/ });
    expect(link).toHaveAttribute('href', '#/sources');
    expect(link).toHaveTextContent('5 of 5 enabled');
    expect(link).toHaveClass('focus-visible:ring-inset');
  });

  it('a link row with an unsafe href is a row of text, never a link', () => {
    for (const href of ['javascript:alert(1)', '//evil.test/x', 'data:text/html,hi']) {
      const { unmount } = render(
        <SettingRow variant="link" label="Connected sources" href={href} value="5 of 5 enabled" />,
      );
      expect(screen.queryByRole('link')).toBeNull();
      const row = screen.getByText('Connected sources').closest('[data-setting-row="link"]')!;
      expect(row.tagName).toBe('DIV');
      expect(row).toHaveTextContent('5 of 5 enabled');
      unmount();
    }
  });

  it('a custom control column width reaches the row', () => {
    render(
      <SettingRow variant="field" controlWidth="20rem">
        <TextPref label="Index pattern" value="all-logs-*" onChange={() => {}} />
      </SettingRow>,
    );
    const row = screen.getByLabelText('Index pattern').closest('[data-setting-row]') as HTMLElement;
    expect(row.style.getPropertyValue('--setting-control-w')).toBe('20rem');
  });

  it('has no accessibility violations and no em dashes', async () => {
    const { container } = chatAssistant();
    expect(await axe(container)).toHaveNoViolations();
    expect(container.textContent).not.toMatch(/[—–]/);
  });
});

/** One row of every variant, in one group (the labels name the variants). */
function everyRow() {
  return (
    <SettingsGroup title="Every row">
      <SettingRow variant="switch" label="A switch" help="Switch help." checked={false} onCheckedChange={() => {}} />
      <SettingRow
        variant="select"
        label="A select"
        help="Select help."
        value="a"
        onValueChange={() => {}}
        options={[{ value: 'a', label: 'Option A' }]}
      />
      <SettingRow variant="field">
        <NumPref label="A field" help="Field help." value={4} onChange={() => {}} />
      </SettingRow>
      <SettingRow variant="field" wide>
        <TextPref label="A wide field" help="Wide field help." value="x" onChange={() => {}} />
      </SettingRow>
      <SettingRow variant="control" label="A control" help="Control help." control={<Button size="sm">Choose</Button>} />
      <SettingRow variant="control" wide label="A wide control" control={<Button size="sm">Choose wide</Button>} />
      <SettingRow variant="status" label="A status" status={<StatusDot>On</StatusDot>} action={<Button size="sm">Turn off</Button>} />
      <SettingRow variant="action" label="An action" action={<Button size="sm">Run</Button>} />
      <SettingRow variant="link" label="A link" href="#/sources" value="5 of 5 enabled" />
      <SettingRow variant="block">
        <p>A block</p>
      </SettingRow>
      <SettingRow variant="block" bleed>
        <p>A bleed block</p>
      </SettingRow>
    </SettingsGroup>
  );
}

/** The row element whose text includes `text` (the label or the block's content). */
function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest('[data-setting-row]') as HTMLElement;
}

const CAP_CLASSES = SETTINGS_ROW_CONTENT_MAX_WIDTH.split(' ');

describe('SettingRow in a full-width section (FX6s)', () => {
  it('caps the content box of every labelled control row, never the row, so the hairline still spans the panel', () => {
    render(
      <SettingsSection title="Enrichment" width="full">
        {everyRow()}
      </SettingsSection>,
    );
    for (const label of ['A switch', 'A select', 'A field', 'A control', 'A status', 'An action']) {
      const row = rowOf(label);
      // The row stays a direct child of the panel (its `divide-y` hairline) with its inset.
      expect(row.parentElement).toHaveAttribute('data-settings-panel');
      expect(row).toHaveClass('px-4', 'py-3.5', 'xl:px-5');
      expect(row.className).not.toMatch(/max-w-/);
      const content = row.querySelectorAll('[data-setting-row-content]');
      expect(content).toHaveLength(1);
      expect(content[0]).toHaveClass(...CAP_CLASSES);
      expect(content[0]).toHaveTextContent(label);
    }
    // A Field-based row's content box is the Field's inline layout root.
    for (const label of ['A select', 'A field']) {
      const content = rowOf(label).querySelector('[data-setting-row-content]');
      expect(content).toHaveAttribute('data-field-layout', 'inline');
    }
    // A switch, control, status and action row: the content box carries the row layout.
    expect(rowOf('A switch').querySelector('[data-setting-row-content]')).toHaveClass('flex', 'justify-between');
    for (const label of ['A control', 'A status', 'An action']) {
      expect(rowOf(label).querySelector('[data-setting-row-content]')).toHaveClass('sm:flex-row', 'sm:justify-between');
    }
  });

  it('leaves block, link and wide rows as they are: a table, a whole-row link or a control under its label', () => {
    render(
      <SettingsSection title="Enrichment" width="full">
        {everyRow()}
      </SettingsSection>,
    );
    for (const text of ['A wide field', 'A wide control', 'A link', 'A block', 'A bleed block']) {
      const row = rowOf(text);
      expect(row.querySelector('[data-setting-row-content]')).toBeNull();
      expect(row.className).not.toMatch(/max-w-/);
    }
    expect(screen.getByLabelText('A wide field').closest('[data-field-layout]')).toHaveAttribute('data-field-layout', 'wide');
  });

  it('keeps every row named and described as before', async () => {
    const { container } = render(
      <SettingsSection title="Enrichment" width="full">
        {everyRow()}
      </SettingsSection>,
    );
    expect(screen.getByRole('switch', { name: 'A switch' })).toHaveAccessibleDescription('Switch help.');
    expect(screen.getByRole('combobox', { name: 'A select' })).toHaveAccessibleDescription('Select help.');
    expect(screen.getByRole('spinbutton', { name: 'A field' })).toHaveAccessibleDescription('Field help.');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders a form section exactly as before the cap: one row element, no content box', () => {
    render(
      <SettingsSection title="Advanced" width="form">
        {everyRow()}
      </SettingsSection>,
    );
    expect(document.querySelector('[data-setting-row-content]')).toBeNull();
    const before: Array<[string, string]> = [
      ['A switch', 'flex items-start justify-between gap-6 px-4 py-3.5 xl:px-5'],
      ['A select', 'px-4 py-3.5 xl:px-5'],
      ['A field', 'px-4 py-3.5 xl:px-5'],
      ['A wide field', 'px-4 py-3.5 xl:px-5'],
      ['A control', 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6 px-4 py-3.5 xl:px-5'],
      ['A wide control', 'min-w-0 px-4 py-3.5 xl:px-5'],
      ['A status', 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6 px-4 py-3.5 xl:px-5'],
      ['An action', 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6 px-4 py-3.5 xl:px-5'],
      [
        'A link',
        'flex items-center gap-4 transition-colors hover:bg-hover px-4 py-3.5 xl:px-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
      ],
      ['A block', 'min-w-0 px-4 py-3.5 xl:px-5'],
      ['A bleed block', 'min-w-0'],
    ];
    for (const [text, className] of before) {
      expect(rowOf(text).className).toBe(className);
    }
    // The inline Field roots take no cap either.
    for (const label of ['A select', 'A field']) {
      expect(rowOf(label).querySelector('[data-field-layout="inline"]')?.className).not.toMatch(/max-w-/);
    }
  });

  it('follows the measure of the section the row is in: the section, then the Settings shell, then form', () => {
    // A section body that lays out its own content (SectionTitle, no SettingsSection)
    // inside a full-width section of the Settings shell.
    const { unmount } = render(
      <SettingsSectionContext.Provider value={{ title: 'Appearance', width: 'full' }}>
        <SectionTitle title="Appearance" />
        {everyRow()}
      </SettingsSectionContext.Provider>,
    );
    expect(rowOf('A switch').querySelector('[data-setting-row-content]')).toHaveClass(...CAP_CLASSES);
    unmount();

    // A form section inside the full-width shell measure is still a form.
    const second = render(
      <SettingsSectionContext.Provider value={{ width: 'full' }}>
        <SettingsSection title="Advanced" width="form">
          {everyRow()}
        </SettingsSection>
      </SettingsSectionContext.Provider>,
    );
    expect(document.querySelector('[data-setting-row-content]')).toBeNull();
    second.unmount();

    // Outside any section or shell: a form row.
    const third = render(everyRow());
    expect(document.querySelector('[data-setting-row-content]')).toBeNull();
    third.unmount();

    // A full-width page on its own route caps its rows; a form page does not.
    const page = render(
      <SettingsPageSection embedded={false} title="Roles & permissions" width="full">
        {everyRow()}
      </SettingsPageSection>,
    );
    expect(rowOf('A status').querySelector('[data-setting-row-content]')).toHaveClass(...CAP_CLASSES);
    page.unmount();
    render(
      <SettingsPageSection embedded={false} title="Security">
        {everyRow()}
      </SettingsPageSection>,
    );
    expect(document.querySelector('[data-setting-row-content]')).toBeNull();
  });

  it('caps the content at a 44rem form section less the row inset on each side', () => {
    render(
      <SettingsSection title="Advanced">
        {everyRow()}
      </SettingsSection>,
    );
    const rem = (cls: string) => Number(/\[([\d.]+)rem\]/.exec(cls)?.[1]);
    const spacing = (cls: string) => Number(/px-(\d+(?:\.\d+)?)$/.exec(cls)?.[1]) / 4; // Tailwind: 1 unit = 0.25rem
    const rowClasses = rowOf('A switch').className.split(' ');
    const pad = spacing(rowClasses.find((c) => /^px-/.test(c))!);
    const padXl = spacing(rowClasses.find((c) => /^xl:px-/.test(c))!);
    const form = rem(SETTINGS_FORM_MAX_WIDTH);
    const [cap, capXl] = CAP_CLASSES;
    expect(cap.startsWith('max-w-')).toBe(true);
    expect(capXl.startsWith('xl:max-w-')).toBe(true);
    expect(rem(cap)).toBe(form - 2 * pad);
    expect(rem(capXl)).toBe(form - 2 * padXl);
  });
});

describe('SettingRow block of form-like content (width="form")', () => {
  /** A group like Roles "Permission check": a row of fields and a button, then its result. */
  function checkGroup() {
    return (
      <SettingsGroup title="Permission check">
        <SettingRow variant="block" width="form">
          <div data-testid="check-grid">
            <Button size="sm">Check</Button>
          </div>
        </SettingRow>
        <SettingRow variant="status" label="Super admin on cases:read" status={<StatusDot>Allowed</StatusDot>} />
        <SettingRow variant="block">
          <p>A table</p>
        </SettingRow>
      </SettingsGroup>
    );
  }

  it('in a full-width section caps the block content with the same box as a labelled control row, so the group keeps one right edge', () => {
    render(
      <SettingsSection title="Roles & permissions" width="full">
        {checkGroup()}
      </SettingsSection>,
    );
    const block = screen.getByTestId('check-grid').closest('[data-setting-row]') as HTMLElement;
    expect(block).toHaveAttribute('data-setting-row', 'block');
    // The row keeps its inset across the panel; only the content box inside it is capped.
    expect(block.parentElement).toHaveAttribute('data-settings-panel');
    expect(block.className).toBe('min-w-0 px-4 py-3.5 xl:px-5');
    const content = block.querySelectorAll('[data-setting-row-content]');
    expect(content).toHaveLength(1);
    expect(content[0]).toBe(screen.getByTestId('check-grid').parentElement);
    expect(content[0].className).toBe(SETTINGS_ROW_CONTENT_MAX_WIDTH);
    // The result row under it caps at the same width: one edge for the button and the badge.
    const status = rowOf('Super admin on cases:read').querySelector('[data-setting-row-content]');
    expect(status).toHaveClass(...CAP_CLASSES);
    // A plain block (a table) in the same group still takes the whole panel.
    expect(rowOf('A table').querySelector('[data-setting-row-content]')).toBeNull();
  });

  it('in a form section renders as a plain block: no content box, the same classes as before', () => {
    render(
      <SettingsSection title="Advanced">
        {checkGroup()}
      </SettingsSection>,
    );
    expect(document.querySelector('[data-setting-row-content]')).toBeNull();
    const block = screen.getByTestId('check-grid').closest('[data-setting-row]') as HTMLElement;
    expect(block.className).toBe('min-w-0 px-4 py-3.5 xl:px-5');
    expect(screen.getByTestId('check-grid').parentElement).toBe(block);
  });

  it('never caps a bleed block: a table that reaches the panel edges has no form width', () => {
    // The props type rejects the pair; the renderer ignores it too.
    // @ts-expect-error a bleed block takes the panel's width only
    const bleedForm: SettingRowProps = { variant: 'block', bleed: true, width: 'form', children: <p>A bleed table</p> };
    render(
      <SettingsSection title="Enrichment" width="full">
        <SettingsGroup title="Providers">
          <SettingRow {...bleedForm} />
        </SettingsGroup>
      </SettingsSection>,
    );
    const row = rowOf('A bleed table');
    expect(row.className).toBe('min-w-0');
    expect(row.querySelector('[data-setting-row-content]')).toBeNull();
  });
});

describe('SettingRow link and the unsaved-changes guard', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  function Guarded() {
    useNavigationBlocker(true, { title: 'Discard unsaved changes?', confirmLabel: 'Discard' });
    return null;
  }

  function mountSettings() {
    window.location.hash = '#/settings?s=general';
    return render(
      <RouterProvider>
        <Guarded />
        <SettingRow variant="link" label="Connected sources" href="#/sources" value="5 of 5 enabled" />
      </RouterProvider>,
    );
  }

  it('asks the guard before leaving Settings on a plain click, so a draft is never dropped', async () => {
    mountSettings();
    const link = screen.getByRole('link', { name: /Connected sources/ });
    // The browser's own hash change is cancelled; the router asks first.
    expect(fireEvent.click(link)).toBe(false);
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings?s=general');
  });

  it('leaves a modified click (new tab, new window) to the browser', () => {
    mountSettings();
    const link = screen.getByRole('link', { name: /Connected sources/ });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(fireEvent.click(link, modifier)).toBe(true);
    }
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('NumPref on the shared NumberField', () => {
  function Controlled({
    initial,
    onChange,
    ...props
  }: Omit<React.ComponentProps<typeof NumPref>, 'value' | 'onChange'> & { initial: number; onChange: (v: number) => void }) {
    const [value, setValue] = React.useState(initial);
    return (
      <NumPref
        {...props}
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  it('never rewrites a stored value that is only tabbed through, even off the step grid', () => {
    const onChange = vi.fn();
    render(
      <>
        <NumPref label="Escalation confidence" value={0.72} step={0.05} onChange={onChange} />
        <NumPref label="Check interval (minutes)" value={20} min={15} max={10_080} step={15} onChange={onChange} />
        <NumPref label="Critical severity" value={7.3} step={0.5} onChange={onChange} />
      </>,
    );
    for (const name of ['Escalation confidence', 'Check interval (minutes)', 'Critical severity']) {
      const input = screen.getByLabelText(name);
      fireEvent.focus(input);
      fireEvent.blur(input);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Escalation confidence')).toHaveValue('0.72');
    expect(screen.getByLabelText('Check interval (minutes)')).toHaveValue('20');
  });

  it('keeps a typed value as typed; the step only sets how far the arrows move', () => {
    const onChange = vi.fn();
    render(<Controlled label="Escalation confidence" initial={0.5} step={0.05} onChange={onChange} />);
    const input = screen.getByLabelText('Escalation confidence');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '0.72' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(0.72);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(0.77);
    // Still clamped to the bounds it declares.
    render(<Controlled label="Max tool calls" initial={10} min={1} step={1} onChange={onChange} />);
    const calls = screen.getByLabelText('Max tool calls');
    fireEvent.focus(calls);
    fireEvent.change(calls, { target: { value: '0' } });
    fireEvent.blur(calls);
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('is an 8rem spinbutton with its bounds, steppers only for values of up to four digits', () => {
    render(
      <>
        <NumPref label="Max tokens / case" value={20000} min={1} step={1} onChange={() => {}} />
        <NumPref label="Relevance floor" value={0.35} min={0} max={1} step={0.05} onChange={() => {}} />
      </>,
    );
    const tokens = screen.getByRole('spinbutton', { name: 'Max tokens / case' });
    expect(tokens).toHaveAttribute('aria-valuemin', '1');
    expect(tokens).not.toHaveAttribute('aria-valuemax');
    expect(tokens).toHaveAttribute('aria-valuenow', '20000');
    const tokensBox = tokens.closest('[data-number-field]') as HTMLElement;
    expect(tokensBox).toHaveAttribute('data-number-field', 'sm');
    expect(within(tokensBox).queryByRole('button', { name: 'Increase' })).toBeNull();
    const floor = screen.getByRole('spinbutton', { name: 'Relevance floor' });
    const floorBox = floor.closest('[data-number-field]') as HTMLElement;
    expect(floorBox).toHaveAttribute('data-number-field', 'sm');
    fireEvent.click(within(floorBox).getByRole('button', { name: 'Increase' }));
  });

  it('widens past 8rem only when a long unit needs the room', () => {
    render(<NumPref label="Window" value={24} min={1} max={168} unit="(24 hours)" onChange={() => {}} />);
    expect(screen.getByLabelText('Window').closest('[data-number-field]')).toHaveAttribute('data-number-field', 'md');
  });
});

describe('StickySaveBar width', () => {
  it('caps the save bar to a form section, or spans the pane', () => {
    const { rerender } = render(<StickySaveBar visible width="form" onSave={() => {}} onDiscard={() => {}} />);
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveClass('max-w-[44rem]');
    rerender(<StickySaveBar visible onSave={() => {}} onDiscard={() => {}} />);
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).not.toHaveClass('max-w-[44rem]');
  });
});
