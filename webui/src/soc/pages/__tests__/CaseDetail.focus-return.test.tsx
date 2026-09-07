/**
 * CaseDetail — focus RETURN when the sheet closes (WCAG 2.4.3).
 *
 * The sheet is opened by STATE from every one of its consumers (the Cases table, the
 * Scans and Investigate boards, and the dashboard's live queue and drill-down), never by
 * a `<SheetTrigger>`. That matters, because `@radix-ui/react-dialog` wires its content's
 * `onCloseAutoFocus` to `event.preventDefault(); context.triggerRef.current?.focus()` —
 * and with no trigger rendered, `triggerRef` is null while the `preventDefault()` still
 * suppresses `FocusScope`'s own restore-to-previous. The result was focus landing on
 * `<body>`: a keyboard operator who closed a case lost their place in the list.
 *
 * This pins the explicit restore that replaces it. It is a REAL mount rather than the
 * source assertion the sibling CaseDetail specs use, because the defect lives in the
 * interaction between our handler and Radix's — which no static read can observe. The api
 * surface is stubbed generically (any accessed method resolves an empty object), so this
 * spec asserts focus behaviour without coupling to the panel data contracts.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import * as React from 'react';

vi.mock('@/lib/api', () => {
  // Any method CaseDetail reaches for resolves an empty payload. The panels then render
  // their own empty states, which is all this spec needs them to do.
  const target: Record<string, unknown> = {};
  return {
    api: new Proxy(target, {
      get: (t, prop) => {
        if (prop === 'then') return undefined;
        if (!(prop in t)) t[prop as string] = vi.fn(() => Promise.resolve({}));
        return t[prop as string];
      },
    }),
  };
});

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({ username: 'probe', hasPermission: () => true, user: null }),
  useCan: () => () => true,
}));

import { CaseDetail } from '@/soc/pages/CaseDetail';

/** A consumer shaped exactly like the real ones: state opens it, state closes it. */
function Host() {
  const [id, setId] = React.useState<string | null>(null);
  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setId('c-focus-1')}>
        Open case
      </button>
      <button type="button" data-testid="elsewhere" onClick={() => setId(null)}>
        Close from outside
      </button>
      {id ? <CaseDetail caseId={id} onClose={() => setId(null)} /> : null}
    </div>
  );
}

describe('CaseDetail — focus return on close', () => {
  it('returns focus to the element that opened the sheet, not to <body>', async () => {
    render(<Host />);

    const opener = screen.getByTestId('opener');
    opener.focus();
    expect(opener).toHaveFocus();

    await act(async () => {
      fireEvent.click(opener);
    });
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
    // Radix moved focus into the sheet, so the opener no longer holds it — which is the
    // whole reason the opener has to have been captured before this point.
    expect(opener).not.toHaveFocus();

    await act(async () => {
      fireEvent.click(screen.getByTestId('elsewhere'));
    });
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    // The assertion that fails without the explicit restore: focus lands on <body> there.
    expect(opener).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });
});
