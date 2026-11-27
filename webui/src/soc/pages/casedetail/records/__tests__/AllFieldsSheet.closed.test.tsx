/**
 * Round 16 (SPEC §4.5 WP14): the inspector mounts "View all fields" closed on every case.
 * A closed sheet asks nothing of the auth context and loads nothing, so a surface that
 * renders the inspector without an auth provider (an embedded rail, a test host) keeps
 * working. The grants are read only inside the open sheet.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { AllFieldsSheet } from '../AllFieldsSheet';

describe('AllFieldsSheet while closed', () => {
  it('renders without an auth provider and loads nothing', () => {
    const load = vi.fn();
    const { container } = render(
      <AllFieldsSheet caseId="case-1" open={false} onOpenChange={() => undefined} load={load} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(load).not.toHaveBeenCalled();
  });
});
