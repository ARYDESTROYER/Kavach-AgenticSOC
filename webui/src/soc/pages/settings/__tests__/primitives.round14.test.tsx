/**
 * Settings grouped panels (Round 14, SPEC §4.9.6, operator choice C9 option A):
 * `SettingsSection` (title row only, 44rem forms, room for the save bar),
 * `SettingsGroup` (title and caption above one tinted panel of hairline-divided rows)
 * and `SettingRow` (switch, select, field, status, action and link rows), plus the
 * `StickySaveBar` width that keeps the save bar under the section it saves, and `NumPref`
 * on the shared NumberField (never snapping a value, never rewriting one on focus alone).
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import {
  NumPref,
  SettingRow,
  SettingsGroup,
  SettingsSection,
  SettingsSectionContext,
  TextPref,
} from '../primitives';
import { StickySaveBar } from '@/soc/components/SettingsGrid';
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
    const group = screen.getByRole('region', { name: 'Spending' });
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
