import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Preferences } from '@/lib/types';
import { AdvancedSection } from '../settings/advanced';
import { ImportCard, ThreatIntelImportCard } from '../Knowledge';

describe('compact icon-control target standard', () => {
  it('keeps Advanced allowlist removal labelled and at least 24px', () => {
    const update = vi.fn();
    render(
      <AdvancedSection
        prefs={{ auto_forward_allowlist: ['suspicious-login'] } as Preferences}
        update={update}
      />,
    );

    const remove = screen.getByRole('button', { name: 'Remove suspicious-login' });
    expect(remove).toHaveClass('min-h-6', 'min-w-6');
    expect(remove.querySelector('svg')).toHaveClass('h-3', 'w-3');
    fireEvent.click(remove);
    expect(update).toHaveBeenCalledWith({ auto_forward_allowlist: [] });
  });

  it('keeps document-import tag removal labelled and at least 24px', () => {
    render(<ImportCard onImported={vi.fn()} />);
    const input = screen.getByLabelText('Tags (optional)');
    fireEvent.change(input, { target: { value: 'cloud' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // The shared TagInput (Round 12 polish): chips name their remove button "Remove {tag}".
    const remove = screen.getByRole('button', { name: 'Remove cloud' });
    expect(remove).toHaveClass('min-h-6', 'min-w-6', '[&_svg]:size-3');
    fireEvent.click(remove);
    expect(screen.queryByRole('button', { name: 'Remove cloud' })).toBeNull();
  });

  it('keeps threat-intel tag removal labelled and at least 24px', () => {
    render(<ThreatIntelImportCard onImported={vi.fn()} />);
    const input = screen.getByLabelText('Tags (optional)');
    fireEvent.change(input, { target: { value: 'campaign' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const remove = screen.getByRole('button', { name: 'Remove campaign' });
    expect(remove).toHaveClass('min-h-6', 'min-w-6', '[&_svg]:size-3');
    fireEvent.click(remove);
    expect(screen.queryByRole('button', { name: 'Remove campaign' })).toBeNull();
  });
});
