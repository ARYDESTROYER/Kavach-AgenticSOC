/**
 * useAutoGrow (SPEC §10.4): engines with `field-sizing: content` size the field in
 * CSS; elsewhere (Firefox) the JS fallback sets the height from `scrollHeight`, capped,
 * and scrolls past the cap. Without a real layout (jsdom, hidden tab) it leaves the CSS
 * minimum alone instead of collapsing the field.
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { supportsFieldSizing, useAutoGrow } from '../useAutoGrow';

function Field({ value, max = 100, width = null }: { value: string; max?: number; width?: number | null }) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value, { maxHeight: max, width });
  return <textarea aria-label="field" ref={ref} value={value} readOnly />;
}

let scrollHeight = 0;
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

afterEach(() => {
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
});

function mockScrollHeight() {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
}

describe('useAutoGrow', () => {
  it('grows to the content, then caps and scrolls', () => {
    mockScrollHeight();
    scrollHeight = 60;
    const { getByLabelText, rerender } = render(<Field value="a" />);
    const el = getByLabelText('field') as HTMLTextAreaElement;
    expect(el.style.height).toBe('60px');
    expect(el.style.overflowY).toBe('hidden');
    scrollHeight = 400;
    rerender(<Field value={'a\n'.repeat(20)} />);
    expect(el.style.height).toBe('100px');
    expect(el.style.overflowY).toBe('auto');
  });

  it('re-measures when the width changes, not only on a keystroke', () => {
    mockScrollHeight();
    scrollHeight = 48;
    const { getByLabelText, rerender } = render(<Field value="a long line" width={600} />);
    const el = getByLabelText('field') as HTMLTextAreaElement;
    expect(el.style.height).toBe('48px');
    // The lane narrowed (rail opened): the same text now wraps to more lines.
    scrollHeight = 72;
    rerender(<Field value="a long line" width={320} />);
    expect(el.style.height).toBe('72px');
  });

  it('keeps the CSS minimum without a layout', () => {
    mockScrollHeight();
    scrollHeight = 0;
    const { getByLabelText } = render(<Field value="a" />);
    expect((getByLabelText('field') as HTMLTextAreaElement).style.height).toBe('');
  });

  it('leaves sizing to CSS where field-sizing is supported', () => {
    vi.stubGlobal('CSS', { supports: (prop: string, value: string) => prop === 'field-sizing' && value === 'content' });
    expect(supportsFieldSizing()).toBe(true);
    mockScrollHeight();
    scrollHeight = 60;
    const { getByLabelText } = render(<Field value="a" />);
    expect((getByLabelText('field') as HTMLTextAreaElement).style.height).toBe('');
  });
});
