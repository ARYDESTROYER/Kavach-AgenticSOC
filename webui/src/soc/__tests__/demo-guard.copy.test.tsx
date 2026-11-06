/**
 * The Demo guard's reason is Console copy (Round 14 SPEC §3.1): SourceEditor shows it on
 * the disabled Test buttons and as their hint. It is a plain sentence-case sentence with
 * no em dash or en dash.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  setUnauthorizedHandler: vi.fn(),
  setReauthHandler: vi.fn(),
  api: { demo: { status: vi.fn().mockResolvedValue({ mode: 'seeded', active: true, run_id: 'demo-1' }) } },
}));

import { DemoProvider, useDemoGuard, type DemoGuard } from '../demo';

describe('the Demo guard reason', () => {
  it('reads as one plain sentence, without an em dash or an en dash', async () => {
    const seen: { current: DemoGuard | null } = { current: null };
    function Probe() {
      seen.current = useDemoGuard();
      return null;
    }
    render(
      <DemoProvider>
        <Probe />
      </DemoProvider>,
    );
    await waitFor(() => expect(seen.current?.disabled).toBe(true));
    expect(seen.current?.reason).toBe('Not available in Demo mode, which blocks real actions.');
    expect(seen.current?.reason).not.toMatch(/[\u2013\u2014]/);
  });
});
