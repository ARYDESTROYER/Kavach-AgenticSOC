/**
 * AccessPopover (SPEC §5.6, §10.4): the caller's catalogue grouped by scope, each
 * tool's label, data source, required permission and ✓ / "Needs <perm>", partly
 * available kind-gated tools, and honest loading / empty states. Strings render as
 * text (#9).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import type { ChatToolInfo } from '@/lib/types';
import { AccessList } from '../AccessPopover';
import { capabilityLabel } from '../access-copy';
import { makeContext } from './fixtures';

expect.extend(toHaveNoViolations);

describe('AccessList', () => {
  it('groups tools by scope with permission and status', async () => {
    const { container } = render(<AccessList context={makeContext({}, { search_logs: 'sources:read' })} />);
    const logs = screen.getByRole('region', { name: 'Logs' });
    // Present-tense capabilities, not the run log's past-tense step labels.
    const row = within(logs).getByText('Search logs').closest('li') as HTMLElement;
    expect(row).toHaveTextContent('Needs sources:read');
    expect(row).toHaveTextContent('Searched logs data');
    const docs = screen.getByRole('region', { name: 'Help docs' });
    expect(within(docs).getByText('Search the Help Center').closest('li')).toHaveTextContent(
      'Allowed. No permission needed',
    );
    // Scope groups appear in catalogue order.
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Logs',
      'Cases',
      'Metrics',
      'Threat intel',
      'Help docs',
      'Platform',
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('flags a kind-gated tool that is only partly available', () => {
    const automation: ChatToolInfo = {
      name: 'automation_status',
      label: 'Checked automation',
      scope: 'platform',
      requires: [],
      allowed: true,
      missing: [],
      kind_requires: { tuning: 'rules:read', schedulers: 'settings:read' },
      kinds_allowed: ['tuning'],
    };
    render(<AccessList context={makeContext({ tools: [automation] })} />);
    expect(screen.getByText('Some details need settings:read')).toBeInTheDocument();
  });

  it('names every grant that would unlock a kind-gated tool, joined with "or"', () => {
    const automation: ChatToolInfo = {
      name: 'automation_status',
      label: 'Read automation status',
      scope: 'platform',
      requires: [],
      allowed: false,
      missing: ['automation:read', 'settings:read', 'proposals:read', 'rules:read'],
      kind_requires: { tuning: 'automation:read', baselines: 'settings:read', approvals: 'proposals:read', rule_versions: 'rules:read' },
      kinds_allowed: [],
    };
    const both: ChatToolInfo = {
      name: 'future_tool',
      label: 'Joined two stores',
      scope: 'platform',
      requires: ['cases:read', 'cost:view'],
      allowed: false,
      missing: ['cases:read', 'cost:view'],
    };
    render(<AccessList context={makeContext({ tools: [automation, both] })} />);
    expect(
      screen.getByText('Needs automation:read or settings:read or proposals:read or rules:read'),
    ).toBeInTheDocument();
    expect(screen.getByText('Needs cases:read and cost:view')).toBeInTheDocument();
  });

  it('says once, with Retry, when the context cannot be read', async () => {
    const onRetry = vi.fn();
    render(<AccessList context={null} error="HTTP 503" onRetry={onRetry} />);
    expect(screen.queryByText('Checking what you can access…')).toBeNull();
    expect(screen.getByText("Couldn't load what the assistant can access.")).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('gives each mounted list its own heading ids', () => {
    const { container } = render(
      <>
        <AccessList context={makeContext()} />
        <AccessList context={makeContext()} />
      </>,
    );
    // aria-labelledby must resolve to THIS list's heading (each list lives in its own
    // labelled popover in the app; two side by side here only test the ids).
    const ids = Array.from(container.querySelectorAll('h3')).map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of Array.from(container.querySelectorAll('section'))) {
      expect(section.querySelector(`#${CSS.escape(section.getAttribute('aria-labelledby') ?? '')}`)).not.toBeNull();
    }
  });

  it('says when it is still loading or there is nothing to list', () => {
    const { rerender } = render(<AccessList context={null} />);
    expect(screen.getByText('Checking what you can access…')).toBeInTheDocument();
    rerender(<AccessList context={makeContext({ tools: [] })} />);
    expect(screen.getByText('The assistant has no data tools for your role.')).toBeInTheDocument();
  });

  it('renders a hostile label as text', () => {
    // An unknown tool name keeps the server label (known names use the client copy).
    const tool: ChatToolInfo = {
      name: 'future_lookup',
      label: '<img src=x onerror=alert(1)>',
      scope: 'cases',
      requires: ['cases:read'],
      allowed: true,
    };
    const { container } = render(<AccessList context={makeContext({ tools: [tool] })} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });
});

describe('capabilityLabel', () => {
  it('maps every known tool to the present tense and converts an unknown run-log verb', () => {
    expect(capabilityLabel({ name: 'search_logs', label: 'Searched logs' })).toBe('Search logs');
    expect(capabilityLabel({ name: 'shift_report', label: 'Built the shift snapshot' })).toBe('Build the shift snapshot');
    expect(capabilityLabel({ name: 'explain_decision', label: 'Explained the decision policy' })).toBe(
      'Explain the decision policy',
    );
    expect(capabilityLabel({ name: 'new_tool', label: 'Looked up a thing' })).toBe('Look up a thing');
    expect(capabilityLabel({ name: 'new_tool', label: 'Checked a thing' })).toBe('Check a thing');
    expect(capabilityLabel({ name: 'new_tool', label: 'Read a thing' })).toBe('Read a thing');
  });
});
