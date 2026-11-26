/**
 * Alert — ARIA role is derived from the variant (round-6 ui-theme).
 *
 * success/info are non-urgent → role="status" (a POLITE live region that does NOT
 * interrupt the screen reader); destructive/warning/default stay role="alert"
 * (assertive), per WAI-ARIA. A caller-supplied `role` still wins.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Alert } from '../alert';

describe('Alert role derivation', () => {
  it('uses role="status" for the non-urgent success variant', () => {
    const { getByText } = render(<Alert variant="success">Saved</Alert>);
    expect(getByText('Saved').getAttribute('role')).toBe('status');
  });

  it('uses role="status" for the non-urgent info variant', () => {
    const { getByText } = render(<Alert variant="info">Heads up</Alert>);
    expect(getByText('Heads up').getAttribute('role')).toBe('status');
  });

  it('keeps role="alert" for the destructive variant', () => {
    const { getByText } = render(<Alert variant="destructive">Failed</Alert>);
    expect(getByText('Failed').getAttribute('role')).toBe('alert');
  });

  it('keeps role="alert" for the warning variant', () => {
    const { getByText } = render(<Alert variant="warning">Careful</Alert>);
    expect(getByText('Careful').getAttribute('role')).toBe('alert');
  });

  it('defaults to role="alert" when no variant is given', () => {
    const { getByText } = render(<Alert>Note</Alert>);
    expect(getByText('Note').getAttribute('role')).toBe('alert');
  });

  it('honours an explicit caller-supplied role over the variant default', () => {
    const { getByText } = render(
      <Alert variant="success" role="alert">
        Urgent success
      </Alert>,
    );
    expect(getByText('Urgent success').getAttribute('role')).toBe('alert');
  });

  it.each([
    ['success', 'text-success-text'],
    ['info', 'text-info-text'],
    ['warning', 'text-warning-text'],
    ['destructive', 'text-critical-text'],
  ] as const)('uses the AA standalone text token for %s copy', (variant, tokenClass) => {
    const { getByText } = render(<Alert variant={variant}>Message</Alert>);
    expect(getByText('Message')).toHaveClass(tokenClass);
  });

  it('centres the icon on a one-line message without nudging the text (alert-icon-off-centre)', () => {
    // 12px padding + half of the 20px line box, less the font's taller ascent, puts the
    // centre of one line of 14px text 21px from the top. The 16px icon at 13px shares
    // it. The old icon sat at 16px (centre 24px) and the text was shifted up 2px, so
    // they were 5px apart on the sign-in page.
    const { getByRole } = render(
      <Alert variant="destructive">
        <svg data-testid="icon" />
        <div>One line</div>
      </Alert>,
    );
    const alert = getByRole('alert');
    expect(alert).toHaveClass('[&>svg]:top-[0.8125rem]', 'py-3');
    expect(alert.className).not.toMatch(/\[&>svg\]:top-4\b/);
    expect(alert.className).not.toMatch(/translate-y/);
  });
});
