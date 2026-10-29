/**
 * Settings form composition visual standard (Round 14, SPEC §4.9.6, C9 option A).
 *
 * The pieces the grouped panels add beyond `primitives.round14.test.tsx`: the
 * compatibility `SectionTitle` that section bodies outside this folder still use (it
 * renders the same title row as `SettingsSection`, with the registry title and help
 * inside the Settings page), `SettingsPageSection` (a section in Settings, a page header
 * on its own route), the `block` and `control` rows, and the retirement of the old
 * grammars (`SectionShell` and its anchor rail, `SubHeader`, `PostureTile`, `SwitchPref`).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import * as primitives from '../primitives';
import {
  NumPref,
  SectionTitle,
  SettingRow,
  SettingsGroup,
  SettingsPageSection,
  SettingsSectionContext,
  TextPref,
} from '../primitives';
import { Button } from '@/ui/button';
import { SegmentedControl } from '@/soc/components/SegmentedControl';

describe('Settings form composition visual standard', () => {
  it('SectionTitle outside Settings shows its own title, with the explanation in a help tip', () => {
    const { container } = render(
      <SectionTitle
        title="Notifications"
        sub="Where alerts are sent."
        actions={<Button size="sm">Test</Button>}
      />,
    );
    const heading = screen.getByRole('heading', { name: 'Notifications', level: 2 });
    expect(heading).toBeInTheDocument();
    // The explanation is never a line under the title: it is the help tip.
    expect(screen.queryByText('Where alerts are sent.')).toBeNull();
    expect(screen.getByRole('button', { name: 'About Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
    // One flat title row: no band, no card chrome.
    const row = container.querySelector('[data-settings-section-title]') as HTMLElement;
    expect(row.className).not.toMatch(/border-b|rounded|shadow|bg-card/);
  });

  it('SectionTitle inside Settings takes the registry title and help, so the h2 equals the rail label', () => {
    render(
      <SettingsSectionContext.Provider value={{ title: 'Appearance', help: 'Your theme and saved views.' }}>
        <SectionTitle title="Appearance & customization" sub="Old subtitle." />
      </SettingsSectionContext.Provider>,
    );
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Appearance & customization' })).toBeNull();
    expect(screen.getByRole('button', { name: 'About Appearance' })).toBeInTheDocument();
  });

  it('SettingsPageSection is a section inside Settings and a page header on its own route', () => {
    const { unmount } = render(
      <SettingsPageSection embedded title="Users" help="Operator accounts." width="full">
        <p>Body</p>
      </SettingsPageSection>,
    );
    expect(screen.getByRole('heading', { name: 'Users', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('region', { name: 'Users' })).toHaveAttribute('data-settings-section', 'full');
    unmount();

    render(
      <SettingsPageSection embedded={false} title="Users & roles" help="Operator accounts.">
        <p>Body</p>
      </SettingsPageSection>,
    );
    expect(screen.getByRole('heading', { name: 'Users & roles', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('wires text and numeric help copy to their controls', () => {
    render(
      <>
        <TextPref label="Index pattern" value="all-logs-*" help="Fallback source scope." onChange={() => {}} />
        <NumPref label="Batch size" value={100} help="Events per durable poll." onChange={() => {}} />
      </>,
    );

    const text = screen.getByLabelText('Index pattern');
    const number = screen.getByLabelText('Batch size');
    expect(text).toHaveAttribute('aria-describedby');
    expect(number).toHaveAttribute('aria-describedby');
    expect(document.getElementById(text.getAttribute('aria-describedby')!)).toHaveTextContent('Fallback source scope.');
    expect(document.getElementById(number.getAttribute('aria-describedby')!)).toHaveTextContent('Events per durable poll.');
  });

  it('a switch row sits on the panel with no mini-card chrome', () => {
    const onChange = vi.fn();
    render(
      <SettingsGroup title="Polling">
        <SettingRow
          variant="switch"
          label="Polling enabled"
          help="Read from every configured pull source."
          checked={false}
          onCheckedChange={onChange}
        />
      </SettingsGroup>,
    );
    const row = document.querySelector('[data-setting-row="switch"]') as HTMLElement;
    expect(row.className).not.toMatch(/rounded|shadow|bg-card|bg-surface|border-b/);
    const toggle = screen.getByRole('switch', { name: 'Polling enabled' });
    expect(toggle).toHaveAttribute('aria-describedby');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('a block row holds free content on the row inset, or bleeds to the panel edge', () => {
    render(
      <SettingsGroup title="Risk weights">
        <SettingRow variant="block">
          <p>Total 100%</p>
        </SettingRow>
        <SettingRow variant="block" bleed>
          <table aria-label="Priority matrix" />
        </SettingRow>
      </SettingsGroup>,
    );
    const rows = document.querySelectorAll('[data-setting-row="block"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].className).toContain('px-4');
    expect(rows[1].className).not.toContain('px-4');
    expect(within(rows[0] as HTMLElement).getByText('Total 100%')).toBeInTheDocument();
  });

  it('a control row gives a composite control its label and help, inline or under the label', () => {
    render(
      <SettingsGroup title="Question limits">
        <SettingRow
          variant="control"
          label="Limits"
          help="Unlimited runs every question to its end."
          helpId="limits-help"
          helpTestId="limits-help-line"
          liveHelp
          control={
            <SegmentedControl
              aria-label="Limits"
              value="unlimited"
              onValueChange={() => {}}
              options={[
                { value: 'unlimited', label: 'Unlimited' },
                { value: 'bounded', label: 'Bounded' },
              ]}
            />
          }
        />
        <SettingRow variant="control" wide label="Typed-out answers" control={<Button size="sm">Choose</Button>} />
      </SettingsGroup>,
    );
    const help = screen.getByTestId('limits-help-line');
    expect(help).toHaveAttribute('id', 'limits-help');
    expect(help).toHaveAttribute('aria-live', 'polite');
    const rows = document.querySelectorAll('[data-setting-row="control"]');
    expect(rows).toHaveLength(2);
    // Inline: the control on the row's end from 640px; wide: the control under the label.
    expect(rows[0].className).toContain('sm:flex-row');
    expect(rows[1].className).not.toContain('sm:flex-row');
    expect(screen.getByRole('button', { name: 'Choose' })).toBeInTheDocument();
  });

  it('retires the old grammars: no anchor rail, sub-header, posture tile or bordered switch row', () => {
    const exported = Object.keys(primitives);
    for (const retired of ['SectionShell', 'SubHeader', 'PostureTile', 'SwitchPref', 'useActiveAnchor']) {
      expect(exported).not.toContain(retired);
    }
  });
});
