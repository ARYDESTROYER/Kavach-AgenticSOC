/**
 * CodeBlock as a scroll region, and its caption (Round 16 bug hunt B78 and B80, WP15F).
 *
 * B78: a capped `<pre>` that scrolls held nothing focusable, so a Safari keyboard user could
 * not scroll a long Raw record (axe scrollable-region-focusable). It becomes a focusable
 * region named by its caption, and only while it overflows, so the many short blocks gain no
 * extra tab stop.
 * B80: the caption truncated, and an inline-flex caption (the "Untrusted source data" trust
 * marker) was cut mid-word with no ellipsis. It now wraps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import { CodeBlock } from '../CodeBlock';

expect.extend(toHaveNoViolations);

const proto = HTMLElement.prototype;
const realScrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
const realClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
let overflowing = false;

beforeEach(() => {
  // A <pre> reports 900 px of content in a 288 px box while `overflowing` is set.
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === 'PRE' && overflowing ? 900 : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === 'PRE' && overflowing ? 288 : 0;
    },
  });
});

afterEach(() => {
  overflowing = false;
  if (realScrollHeight) Object.defineProperty(proto, 'scrollHeight', realScrollHeight);
  if (realClientHeight) Object.defineProperty(proto, 'clientHeight', realClientHeight);
});

describe('CodeBlock scroll region (B78)', () => {
  it('is a focusable region named by its caption while it overflows', async () => {
    overflowing = true;
    const { container } = render(<CodeBlock value={'{\n  "a": 1\n}'} caption="Raw record" maxHeightClassName="max-h-72" />);
    const region = screen.getByRole('region', { name: 'Raw record' });
    expect(region.tagName).toBe('PRE');
    expect(region).toHaveAttribute('tabindex', '0');
    const results = await act(() => axe(container, { runOnly: { type: 'rule', values: ['scrollable-region-focusable', 'aria-allowed-role'] } }));
    expect(results).toHaveNoViolations();
  });

  it('takes the name "Code" when it has no caption', () => {
    overflowing = true;
    render(<CodeBlock value="x" copyable={false} />);
    expect(screen.getByRole('region', { name: 'Code' })).toHaveAttribute('tabindex', '0');
  });

  it('a block that fits adds no tab stop and no region', () => {
    overflowing = false;
    const { container } = render(<CodeBlock value="short" caption="Query" />);
    const pre = container.querySelector('pre')!;
    expect(pre).not.toHaveAttribute('tabindex');
    expect(pre).not.toHaveAttribute('role');
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('CodeBlock caption (B80)', () => {
  it('wraps instead of truncating, so a trust marker is never cut mid-word', () => {
    render(
      <CodeBlock
        value="raw"
        caption={
          <span className="inline-flex items-center gap-1.5">
            evidence · <span>Untrusted source data</span>
          </span>
        }
      />,
    );
    const caption = screen.getByText('Untrusted source data').closest('span.font-mono') as HTMLElement;
    expect(caption).not.toBeNull();
    expect(caption).not.toHaveClass('truncate');
    expect(caption).toHaveClass('min-w-0', 'break-words');
    // The header lets a two-line caption sit beside Copy at the top.
    expect(caption.parentElement).toHaveClass('items-start');
  });
});
