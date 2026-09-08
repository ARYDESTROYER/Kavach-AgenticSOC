/**
 * HelpTip — the tooltip/popover switch, and the flag that overrides it.
 *
 * There were no specs for this component at all, which is how `alwaysPopover` came to be
 * load-bearing and invisible at the same time: `HumanVsAiCard` relies on it to keep the
 * AGENTS.md §3 advisory reachable now that the sentence is nowhere on the card face, but
 * the card's own help text is long enough that the LENGTH heuristic would pick a popover
 * anyway — so deleting the flag as "unused" passed every gate in the repo.
 *
 * These cases pin the difference where it is actually observable: with SHORT text, where
 * the heuristic and the flag disagree.
 *
 * Why the presentation matters rather than being a style choice: a Radix tooltip opens on
 * hover and on focus, and never on TOUCH. Help that carries a disclosure an operator must
 * be able to read — in particular one RELOCATED out of always-visible copy — has to be a
 * popover, or it has been deleted for tablet users rather than tidied.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HelpTip } from '../HelpTip';

const SHORT = 'Counts closed cases.';
/** Comfortably over HelpTip's 80-character switch. */
const LONG =
  'Attribution records the LAST decider on a case, not proof of who did the work, so an ' +
  'agent-closed case a human later acknowledges moves into the human share.';

describe('HelpTip — presentation switch', () => {
  it('renders SHORT help as a tooltip: clicking the trigger opens no dialog', async () => {
    const user = userEvent.setup();
    render(<HelpTip text={SHORT} label="About closed cases" />);
    const trigger = screen.getByRole('button', { name: 'About closed cases' });
    await user.click(trigger);
    // The tooltip presentation has no dialog to open, which is exactly why it is the wrong
    // home for a disclosure: a touch user gets nothing from this press.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders LONG help as a popover without any flag', async () => {
    const user = userEvent.setup();
    render(<HelpTip text={LONG} label="About attribution" />);
    await user.click(screen.getByRole('button', { name: 'About attribution' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/records the LAST decider/i);
  });

  it('forces the popover for SHORT help when alwaysPopover is set — click, Enter and Space', async () => {
    const user = userEvent.setup();
    render(<HelpTip text={SHORT} label="About closed cases" alwaysPopover />);
    const trigger = screen.getByRole('button', { name: 'About closed cases' });

    await user.click(trigger);
    expect(await screen.findByRole('dialog')).toHaveTextContent(SHORT);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveTextContent(SHORT);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    trigger.focus();
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog')).toHaveTextContent(SHORT);
  });

  it('tells the host when the POPOVER opens, and never for the tooltip', async () => {
    // A host stands its own floating surfaces down while this is up (the KPI tiles do it
    // for their hover trend card). The tooltip presentation cannot coexist with anything,
    // so it deliberately never fires.
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <HelpTip text={SHORT} label="About it" onOpenChange={onOpenChange} />,
    );
    await user.click(screen.getByRole('button', { name: 'About it' }));
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(<HelpTip text={SHORT} label="About it" alwaysPopover onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'About it' }));
    await screen.findByRole('dialog');
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('keeps a >=24px hit target on the trigger (WCAG 2.5.8)', () => {
    render(<HelpTip text={SHORT} label="About it" />);
    // The glyph stays 14px; the BUTTON is what has to be reachable.
    expect(screen.getByRole('button', { name: 'About it' })).toHaveClass('min-h-6', 'min-w-6');
  });
});
