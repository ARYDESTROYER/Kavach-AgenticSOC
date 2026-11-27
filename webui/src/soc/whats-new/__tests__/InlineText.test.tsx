/**
 * InlineText: release-note marks render as text, and a long code value wraps inside the
 * column (FXE: the `.env` line the 0.2.0 notes ask for ran off a 390 px screen).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { InlineText } from '../InlineText';

describe('InlineText', () => {
  it('lets a long code value wrap anywhere so it never runs off a phone screen', () => {
    render(
      <p>
        <InlineText text="Set `AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC` in .env first." />
      </p>,
    );
    const code = screen.getByText('AGENTIC_SOC_UPDATE_REPOSITORY=ARYDESTROYER/Kavach-AgenticSOC');
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('[overflow-wrap:anywhere]');
  });

  it('renders bold and code marks as elements and everything else as text', () => {
    const { container } = render(
      <p>
        <InlineText text="**Bold** and `code` and <b>plain</b>" />
      </p>,
    );
    expect(container.querySelector('strong')).toHaveTextContent('Bold');
    expect(container.querySelector('code')).toHaveTextContent('code');
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<b>plain</b>');
  });
});
