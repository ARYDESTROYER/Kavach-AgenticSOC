/**
 * Field layouts (Round 14, SPEC §4.9.2 and §4.9.6): `stacked` (label above, the default),
 * `inlineFieldLayout` (a Settings row: label and help on the left, the control on the
 * row's end; under 640px the control stacks under the help) and `wideFieldLayout` (a
 * Settings row for a wide control: label, help, then the control at full width). The row
 * layouts are renderers in the lazy Settings primitives (SPEC §3.4: Field ships at first
 * paint with Login and Wizard, the rows do not). A `FieldLayoutContext` provider (what
 * `SettingRow` uses) sets the layout of every Field inside it, so the wiring of label,
 * description and error is identical in all of them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Field, FieldLayoutContext, type FieldParts } from '../Field';
import { inlineFieldLayout, wideFieldLayout } from '@/soc/pages/settings/field-layouts';
import { inlineFieldLayout as inlineFromPrimitives, wideFieldLayout as wideFromPrimitives } from '@/soc/pages/settings/primitives';
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
      <Field label="Index pattern" description="Fallback source scope." layout={inlineFieldLayout}>
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
      <Field label="Typed-out answers" description="Answers arrive whole until a viewer turns this on." layout={wideFieldLayout}>
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
      <Field label="Internal domains" error="One domain per line" layout={wideFieldLayout}>
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
      <Field label="Log index" layout={inlineFieldLayout}>
        <Input />
      </Field>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("sm:[grid-template-areas:'label_control'_'error_error']");
  });

  it('takes the layout from the context, and an explicit prop wins over it', () => {
    render(
      <FieldLayoutContext.Provider value={inlineFieldLayout}>
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
      <Field label="Threshold" error="Too high" layout={inlineFieldLayout}>
        <Input />
      </Field>,
    );
    const error = screen.getByRole('alert');
    expect(error).toHaveClass('[grid-area:error]');
    expect(screen.getByLabelText('Threshold')).toHaveAttribute('aria-invalid', 'true');
  });

  it('hands a row renderer the wired parts: ids, row label classes, the root props and the ref', () => {
    let seen: FieldParts | null = null;
    const ref = React.createRef<HTMLDivElement>();
    render(
      <Field
        ref={ref}
        label="Retention"
        description="Days kept."
        error="Too long"
        required
        labelClassName="tracking-tight"
        className="row-class"
        data-testid="row-root"
        layout={(parts) => {
          seen = parts;
          return (
            <div ref={parts.rootRef} className={parts.className} {...parts.rootProps}>
              {parts.label('text-base leading-5')}
              {parts.control}
              <p id={parts.descriptionId}>{parts.description}</p>
              <p id={parts.errorId} role="alert">
                {parts.error}
              </p>
            </div>
          );
        }}
      >
        <Input />
      </Field>,
    );
    const control = screen.getByLabelText(/Retention/);
    const parts = seen as unknown as FieldParts;
    // The control already carries the wiring; the renderer only places the parts.
    expect(control).toHaveAttribute('aria-describedby', `${parts.descriptionId} ${parts.errorId}`);
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAttribute('aria-required', 'true');
    const label = screen.getByText('Retention');
    expect(label).toHaveClass('text-base', 'leading-5', 'tracking-tight');
    expect(label.querySelector('[aria-hidden="true"]')).toHaveTextContent('*');
    expect(screen.getByTestId('row-root')).toBe(ref.current);
    expect(screen.getByTestId('row-root')).toHaveClass('row-class');
    expect(screen.getByRole('alert')).toHaveTextContent('Too long');
  });

  it('exports the same row renderers from the Settings primitives', () => {
    expect(inlineFromPrimitives).toBe(inlineFieldLayout);
    expect(wideFromPrimitives).toBe(wideFieldLayout);
  });

  it('keeps the Settings row layouts out of the first-paint Field module (SPEC §3.4)', () => {
    // Field ships at first paint (Login and Wizard import it); the rows live with the
    // lazy Settings primitives, so Field.tsx itself draws only the stacked layout.
    const source = readFileSync(path.resolve(__dirname, '..', 'Field.tsx'), 'utf8');
    expect(source).not.toContain('data-field-layout');
    expect(source).not.toContain('--setting-control-w');
    expect(source).not.toMatch(/from\s+['"][^'"]*pages\/settings/);
  });
});
