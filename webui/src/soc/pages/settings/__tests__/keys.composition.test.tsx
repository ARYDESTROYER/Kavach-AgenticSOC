import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ConfiguredStatus } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { KeysSection } from '../keys';
import { SettingsSectionContext } from '../primitives';
import { SECTION_META_BY_ID } from '../settings-sections-meta';

describe('KeysSection composition', () => {
  it('groups write-only credentials under the one Settings-wide save contract', () => {
    // The Settings shell hands every section its registry title and help (one source).
    const meta = SECTION_META_BY_ID.keys;
    const { container } = render(
      <TooltipProvider>
        <SettingsSectionContext.Provider value={{ title: meta.title, help: meta.help }}>
          <KeysSection
            configured={{ openai_api_key: true } as ConfiguredStatus}
            draft={{ openai_api_key: 'replacement' }}
            setDraft={vi.fn()}
            saving={false}
            readOnly={false}
          />
        </SettingsSectionContext.Provider>
      </TooltipProvider>,
    );

    // Round 14 (C9 option A): three groups, each a titled panel of key rows.
    expect(container.querySelectorAll('[data-settings-group]')).toHaveLength(3);
    for (const title of ['Data access', 'AI runtime', 'Threat intelligence']) {
      expect(screen.getByRole('heading', { name: title, level: 3 })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Secret keys', level: 2 })).toBeInTheDocument();
    // No per-section save: the Settings save bar saves keys; the explanation is the help tip.
    expect(screen.queryByRole('button', { name: 'Update keys' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Secret keys' })).toBeInTheDocument();
    expect(screen.queryByText(/write-only/i)).not.toBeInTheDocument();
  });

  it('disables write-only inputs while the Settings save is in flight', () => {
    render(
      <TooltipProvider>
        <KeysSection
          configured={{} as ConfiguredStatus}
          draft={{}}
          setDraft={vi.fn()}
          saving
          readOnly={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText('OpenAI API key')).toBeDisabled();
  });
});
