/**
 * TagInput pending text and length limits (Round 12 polish).
 *
 * The tour found a sentence typed into the close dialog's Tags field saved as the tag
 * "Scheduled vendor API sync from the known": the field added its pending text on
 * blur and the server cut it to 40 characters. The contract now:
 *  - only Enter or a delimiter adds a chip; blur never does;
 *  - pending text stays visible with an inline "Not added yet" hint;
 *  - a form that would lose it flags the field (`pendingBlocked`) instead;
 *  - a value over `maxLength` is refused with a message, never cut, and the input
 *    carries no `maxlength` attribute (which would cut a paste silently).
 */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

import { CASE_TAG_MAX_CHARS, caseTagError, tagCharCount } from '@/lib/tags';
import {
  TAG_FIELD_SCROLL_MARGIN,
  TAG_FULL_PENDING,
  TAG_PENDING_BLOCKED,
  TAG_PENDING_HINT,
  TagInput,
  focusTagInput,
  usePendingTagDraft,
} from '../TagInput';

const SENTENCE = 'Scheduled vendor API sync from the known service account';

describe('TagInput pending text', () => {
  it('never adds pending text on blur, and says it is not added yet', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={[]} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'vendor-sync' } });
    const hint = screen.getByTestId('tag-input-pending');
    expect(hint).toHaveTextContent(TAG_PENDING_HINT);
    expect(input.getAttribute('aria-describedby')).toContain(hint.id);
    // Muted while typing, the warning tone once focus has left it behind.
    expect(hint).toHaveClass('text-muted-foreground');
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('vendor-sync');
    expect(screen.getByTestId('tag-input-pending')).toHaveClass('text-warning-text');
  });

  it('adds on Enter and clears the hint', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['a']} onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    fireEvent.change(input, { target: { value: '  vendor-sync ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['a', 'vendor-sync']);
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('tag-input-pending')).toBeNull();
  });

  it('turns the hint into an error when a submit found the text pending', () => {
    render(<TagInput label="Tags" value={[]} onChange={vi.fn()} inputValue="vendor-sync" pendingBlocked />);
    expect(screen.getByRole('alert')).toHaveTextContent(TAG_PENDING_BLOCKED);
    expect(screen.getByRole('textbox', { name: 'Tags' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('tag-input-pending')).toBeNull();
  });
});

describe('TagInput length limit', () => {
  it('refuses a value over maxLength with a message and never cuts it', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={[]} onChange={onChange} maxLength={CASE_TAG_MAX_CHARS} />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    expect(input).not.toHaveAttribute('maxlength');
    fireEvent.change(input, { target: { value: SENTENCE } });
    expect(screen.getByRole('alert')).toHaveTextContent(
      `This is longer than ${CASE_TAG_MAX_CHARS} characters. Shorten it to add it.`,
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    // The full text is still there to shorten: nothing was cut.
    expect(input).toHaveValue(SENTENCE);
  });

  it('accepts a value exactly at the limit, counting characters as the server does', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={[]} onChange={onChange} maxLength={CASE_TAG_MAX_CHARS} />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    const exact = 'x'.repeat(CASE_TAG_MAX_CHARS - 1) + '🔒'; // 40 code points, 41 UTF-16 units
    expect(tagCharCount(exact)).toBe(CASE_TAG_MAX_CHARS);
    fireEvent.change(input, { target: { value: exact } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([exact]);
  });

  it('caseTagError mirrors the server bound', () => {
    expect(caseTagError('x'.repeat(CASE_TAG_MAX_CHARS))).toBeNull();
    expect(caseTagError('x'.repeat(CASE_TAG_MAX_CHARS + 1))).toMatch(/longer than 40 characters/);
  });
});

describe('usePendingTagDraft', () => {
  it('settles when nothing is pending, and flags and focuses the field otherwise', () => {
    const { result } = renderHook(() => usePendingTagDraft());
    expect(result.current.settled()).toBe(true);

    const input = document.createElement('input');
    document.body.appendChild(input);
    (result.current.bind.ref as React.MutableRefObject<HTMLInputElement | null>).current = input;
    act(() => result.current.bind.onInputValueChange('half typed'));
    let ok = true;
    act(() => {
      ok = result.current.settled();
    });
    expect(ok).toBe(false);
    expect(result.current.bind.pendingBlocked).toBe(true);
    expect(document.activeElement).toBe(input);

    // Typing again clears the flag; reset clears the text.
    act(() => result.current.bind.onInputValueChange('half typed!'));
    expect(result.current.bind.pendingBlocked).toBe(false);
    act(() => result.current.reset());
    expect(result.current.text).toBe('');
    input.remove();
  });
});

/**
 * The line under the field stays on screen (tour reverify: at 1440x900 the close
 * dialog's "Not added yet" sat below its scroll area, so a blocked Close looked like it
 * did nothing). A focused input that is on screen does not scroll its container, so the
 * field brings itself, message included, into view.
 */
describe('TagInput keeps its message in view', () => {
  afterEach(() => vi.restoreAllMocks());

  /** The elements `scrollIntoView` was called on, with their options. */
  function spyScroll() {
    const calls: Array<{ el: Element; opts: unknown }> = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, opts?: unknown) {
      calls.push({ el: this, opts });
    });
    return calls;
  }

  /** The field wrapper: the element that holds the label, the input and its message. */
  function fieldOf(input: HTMLElement): HTMLElement {
    return input.closest(`.${TAG_FIELD_SCROLL_MARGIN}`) as HTMLElement;
  }

  it('scrolls the whole field into view as the hint appears while typing', () => {
    const calls = spyScroll();
    render(<TagInput label="Tags" value={[]} onChange={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    const field = fieldOf(input);
    expect(field).not.toBeNull();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'vendor-sync' } });
    const hint = screen.getByTestId('tag-input-pending');
    const last = calls.at(-1);
    expect(last?.el).toBe(field);
    expect(last?.opts).toEqual({ block: 'nearest' });
    // The revealed element holds the input and the line under it.
    expect(field.contains(input) && field.contains(hint)).toBe(true);
  });

  it('scrolls the refusal into view while typing past the length limit', () => {
    const calls = spyScroll();
    render(<TagInput label="Tags" value={[]} onChange={vi.fn()} maxLength={CASE_TAG_MAX_CHARS} />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: SENTENCE } });
    const alert = screen.getByRole('alert');
    expect(calls.at(-1)?.el).toBe(fieldOf(input));
    expect(fieldOf(input).contains(alert)).toBe(true);
  });

  it('does not scroll a field the person is not in, until a submit flags it', () => {
    const calls = spyScroll();
    const { rerender } = render(
      <TagInput label="Tags" value={[]} onChange={vi.fn()} inputValue="vendor-sync" />,
    );
    expect(calls).toHaveLength(0);
    rerender(<TagInput label="Tags" value={[]} onChange={vi.fn()} inputValue="vendor-sync" pendingBlocked />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    expect(screen.getByRole('alert')).toHaveTextContent(TAG_PENDING_BLOCKED);
    expect(calls.map((c) => c.el)).toContain(fieldOf(input));
  });

  it('focusTagInput brings the field back into view even when the input already has focus', () => {
    const calls = spyScroll();
    render(<TagInput label="Tags" value={[]} onChange={vi.fn()} inputValue="vendor-sync" pendingBlocked />);
    const input = screen.getByRole('textbox', { name: 'Tags' }) as HTMLInputElement;
    act(() => input.focus());
    calls.length = 0;
    // Focusing a focused input fires nothing and scrolls nothing on its own.
    act(() => focusTagInput(input));
    expect(document.activeElement).toBe(input);
    expect(calls.map((c) => c.el)).toEqual([fieldOf(input)]);
  });

  it('usePendingTagDraft: a blocked submit reveals the field with its error', () => {
    const calls = spyScroll();
    let settle: () => boolean = () => true;
    function Form() {
      const draft = usePendingTagDraft();
      settle = draft.settled;
      return <TagInput label="Tags" value={[]} onChange={vi.fn()} {...draft.bind} />;
    }
    render(<Form />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    fireEvent.change(input, { target: { value: 'half typed' } });
    act(() => input.blur());
    calls.length = 0;
    let ok = true;
    act(() => {
      ok = settle();
    });
    expect(ok).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('alert')).toHaveTextContent(TAG_PENDING_BLOCKED);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.el === fieldOf(input))).toBe(true);
  });
});

describe('TagInput at its chip cap', () => {
  it('is disabled when full and empty', () => {
    render(<TagInput label="Tags" value={['a', 'b']} onChange={vi.fn()} max={2} />);
    expect(screen.getByRole('textbox', { name: 'Tags' })).toBeDisabled();
  });

  it('keeps typed text editable and says it cannot be added, so it can be cleared', () => {
    const onChange = vi.fn();
    render(<TagInput label="Tags" value={['a', 'b']} onChange={onChange} max={2} inputValue="c" />);
    const input = screen.getByRole('textbox', { name: 'Tags' });
    expect(input).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(TAG_FULL_PENDING);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
