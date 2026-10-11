/**
 * BulkCloseDialog + DispositionPicker (Round 12, D15 / CM-7): every terminal path —
 * including bulk close — captures the outcome. The picker opens EMPTY (G1), the submit
 * stays disabled until a person chooses, and the payload is declared.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { BulkCloseDialog } from '../BulkCloseDialog';
import { DispositionPicker, aiSuggestedDisposition } from '../DispositionPicker';

describe('BulkCloseDialog', () => {
  it('requires a disposition and submits it as declared', () => {
    const onSubmit = vi.fn();
    render(<BulkCloseDialog action="close" count={3} onCancel={vi.fn()} onSubmit={onSubmit} />);
    const submit = screen.getByRole('button', { name: 'Close 3 cases' });
    // G1: nothing is pre-selected, so the submit is disabled.
    expect(submit).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();

    fireEvent.click(screen.getByRole('radio', { name: /false positive/i }));
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/analyst note/i), { target: { value: '  scanner noise ' } });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'close',
      disposition: 'false_positive',
      disposition_declared: true,
      note: 'scanner noise',
    });
  });

  it('resolve sends the note as the reason too', () => {
    const onSubmit = vi.fn();
    render(<BulkCloseDialog action="resolve" count={1} onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /true positive/i }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'contained' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve 1 case' }));
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'resolve',
      disposition: 'true_positive',
      disposition_declared: true,
      reason: 'contained',
      note: 'contained',
    });
  });

  it('keeps the actions in a footer outside the scrolling body', () => {
    render(<BulkCloseDialog action="close" count={2} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const dialog = screen.getByTestId('bulk-close-dialog');
    const submit = screen.getByRole('button', { name: 'Close 2 cases' });
    const scroller = dialog.querySelector('.overflow-y-auto');
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(submit)).toBe(false);
  });

  it('renders nothing while closed', () => {
    render(<BulkCloseDialog action={null} count={2} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('bulk-close-dialog')).toBeNull();
  });
});

describe('DispositionPicker', () => {
  it('the AI suggestion is a read-only hint, never a default', () => {
    const onChange = vi.fn();
    render(<DispositionPicker value="" onChange={onChange} verdict="FALSE_POSITIVE" currentDisposition="none" />);
    expect(screen.getByTestId('disposition-ai-hint')).toHaveTextContent('AI suggested: False positive');
    expect(onChange).not.toHaveBeenCalled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('number keys 1–6 choose an option', () => {
    const onChange = vi.fn();
    render(<DispositionPicker value="" onChange={onChange} />);
    fireEvent.keyDown(document, { key: '2' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('maps only concrete verdicts to a suggestion', () => {
    expect(aiSuggestedDisposition('TRUE_POSITIVE')).toBe('true_positive');
    expect(aiSuggestedDisposition('NEEDS_HUMAN')).toBeNull();
  });
});
