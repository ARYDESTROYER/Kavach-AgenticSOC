/**
 * Field layouts (Round 14, SPEC §4.9.2 and §4.9.6): `stacked` (label above, the default),
 * `inline` (a Settings row: label and help on the left, the control on the row's end;
 * under 640px the control stacks under the help) and `wide` (a Settings row for a wide
 * control: label, help, then the control at full width). A `FieldLayoutContext` provider
 * (what `SettingRow` uses) sets the layout of every Field inside it, so the wiring of
 * label, description and error is identical in both.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Field, FieldLayoutContext } from '../Field';
import { Input } from '@/ui/input';

describe('Field layout', () => {
  it('stacks the label above the control by default', () => {
    const { container } = render(
      <Field label="Index pattern" description="Fallback source scope.">
        <Input />
      </Field>,
    );
    expect(container.firstElementChild).toHaveClass('space-y-1.5');
    expect(container.firstElementChild).not.toHaveAttribute('data-field-layout');
  });

  it('lays out a row inline: label and help on the left, the control on the end of a 16rem column', () => {
    const { container } = render(
      <Field label="Index pattern" description="Fallback source scope." layout="inline">
        <Input />
      </Field>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-field-layout', 'inline');
    expect(root.className).toContain('sm:grid-cols-[minmax(0,1fr)_var(--setting-control-w,16rem)]');
    // Description present: the control spans the label and the description rows.
    expect(root.className).toContain("sm:[grid-template-areas:'label_control'_'desc_control'_'error_error']");
    // The phone order keeps the description under the label and the control under both.
    expect(root.className).toContain("[grid-template-areas:'label'_'desc'_'control'_'error']");
    const control = screen.getByLabelText('Index pattern');
    expect(control.parentElement).toHaveClass('[grid-area:control]', 'sm:justify-end');
    const help = screen.getByText('Fallback source scope.');
    expect(help).toHaveClass('[grid-area:desc]', 'text-sm', 'max-w-[42rem]');
    // The label is the 14px row label.
    expect(screen.getByText('Index pattern')).toHaveClass('text-base');
    // Wiring is unchanged.
    expect(control).toHaveAttribute('aria-describedby', help.id);
  });

  it('lays out a wide row: the 14px label, then the 13px help, then the control at full width', () => {
    const { container } = render(
      <Field label="Typed-out answers" description="Answers arrive whole until a viewer turns this on." layout="wide">
        <Input />
      </Field>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-field-layout', 'wide');
    const label = screen.getByText('Typed-out answers');
    const help = screen.getByText('Answers arrive whole until a viewer turns this on.');
    const control = screen.getByLabelText('Typed-out answers');
    expect(label).toHaveClass('text-base', 'leading-5');
    expect(help).toHaveClass('mt-0.5', 'max-w-[42rem]', 'text-sm', 'text-muted-foreground');
    // DOM order is the reading order: label, help, control.
    expect(label.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(control.parentElement).toHaveClass('mt-2', 'min-w-0');
    // Wiring is unchanged.
    expect(control).toHaveAttribute('aria-describedby', help.id);
  });

  it('keeps a wide row error announced under the control', () => {
    render(
      <Field label="Internal domains" error="One domain per line" layout="wide">
        <Input />
      </Field>,
    );
    const control = screen.getByLabelText('Internal domains');
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('One domain per line');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the label on the control line when there is no description', () => {
    const { container } = render(
      <Field label="Log index" layout="inline">
        <Input />
      </Field>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("sm:[grid-template-areas:'label_control'_'error_error']");
  });

  it('takes the layout from the context, and an explicit prop wins over it', () => {
    render(
      <FieldLayoutContext.Provider value="inline">
        <Field label="From context">
          <Input />
        </Field>
        <Field label="Explicit" layout="stacked">
          <Input />
        </Field>
      </FieldLayoutContext.Provider>,
    );
    expect(screen.getByLabelText('From context').closest('[data-field-layout]')).toHaveAttribute(
      'data-field-layout',
      'inline',
    );
    expect(screen.getByLabelText('Explicit').closest('[data-field-layout]')).toBeNull();
  });

  it('places the error under the whole row and keeps it announced', () => {
    render(
      <Field label="Threshold" error="Too high" layout="inline">
        <Input />
      </Field>,
    );
    const error = screen.getByRole('alert');
    expect(error).toHaveClass('[grid-area:error]');
    expect(screen.getByLabelText('Threshold')).toHaveAttribute('aria-invalid', 'true');
  });
});
