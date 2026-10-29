/**
 * The Help Center card for runbooks (Round 14, SPEC §4.10.16): "Runbooks" opens the
 * runbooks guide, approvals keep a card of their own, and the search hint and every card
 * avoid the retired word.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ReleaseIdentity } from '@/lib/release';
import Docs from '../Docs';

const release: ReleaseIdentity = { version: '0.1.13', channel: 'testing', commitSha: 'abc1234', buildTime: '2026-10-29T00:00:00Z' };

describe('Help Center runbooks card', () => {
  it('opens the runbooks guide and keeps approvals on a card of their own', () => {
    render(<Docs releaseIdentity={release} backendInfo={null} />);
    expect(screen.getByRole('link', { name: /^Runbooks/ })).toHaveAttribute('href', '/docs/0.1/intelligence/runbooks/');
    expect(screen.getByRole('link', { name: /^Approvals/ })).toBeInTheDocument();
    expect(screen.queryByText(/playbook/i)).toBeNull();
  });

  it('finds the runbooks guide by search and never suggests the retired word', () => {
    render(<Docs releaseIdentity={release} backendInfo={null} />);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'checklist' } });
    const hrefs = screen.getAllByRole('link', { name: /runbooks/i }).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/docs/0.1/intelligence/runbooks/');
    fireEvent.change(search, { target: { value: 'zzzz no such guide' } });
    expect(screen.getByText('Try a feature name such as cases, runbooks, backup, or permissions.')).toBeInTheDocument();
  });
});
