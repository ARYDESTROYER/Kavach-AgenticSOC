/**
 * `WidgetConfigSheet`: the per-widget configuration side sheet (Round 5 / G7, CD4
 * step 4). Selecting/adding a widget opens this Radix `Sheet`; its fields come from
 * the registry's declarative `configFields` (MVP: a plain-text title override + typed
 * `select`s) and map 1:1 onto the widget's `options` bag.
 *
 * The MVP always exposes at least a title override so an operator can rename a widget.
 * The title (and any free-text option) is UNTRUSTED operator input: it is written as a
 * PLAIN string into `options` (#9) and only ever rendered as text/SVG downstream; the
 * server re-validates the option bag + title on PUT (defense-in-depth). A layout is
 * advisory (#3): nothing here touches `decide()`.
 *
 * Fully keyboard-operable (Radix focus trap + `Field` label association). "Apply"
 * commits the edited options back to the widget; "Cancel" discards.
 */
import * as React from 'react';
import { Settings2 } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/ui/sheet';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Field } from '@/soc/components/Field';

import type { DashboardWidget } from '@/lib/types';
import { getWidgetDef } from './registry';
import type { WidgetConfigField } from './registry';
import { widgetOptions } from './layout-utils';

const TITLE_FIELD: WidgetConfigField = {
  key: 'title',
  label: 'Title',
  kind: 'text',
  placeholder: 'Override the widget title',
};

export interface WidgetConfigSheetProps {
  /** The widget being configured (null closes the sheet). */
  widget: DashboardWidget | null;
  onOpenChange: (open: boolean) => void;
  /** Commit the edited options bag back onto the widget. */
  onApply: (widget: DashboardWidget, options: Record<string, unknown>) => void;
  /**
   * As the sheet closes, before the focus returns to its opener: `preventDefault()` and
   * focus another control (the builder hands it to the widget's options button, since the
   * menu item that opened the sheet is gone).
   */
  onCloseAutoFocus?: (event: Event) => void;
}

export function WidgetConfigSheet({ widget, onOpenChange, onApply, onCloseAutoFocus }: WidgetConfigSheetProps) {
  const def = widget ? getWidgetDef(widget.type ?? '') : undefined;

  // Local draft of the options bag, re-seeded whenever the target widget changes.
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    setDraft(widget ? { ...widgetOptions(widget) } : {});
  }, [widget]);

  // Fields: registry-declared, else just the universal title override.
  const fields: WidgetConfigField[] = React.useMemo(() => {
    const declared = def?.configFields ?? [];
    return declared.length ? declared : [TITLE_FIELD];
  }, [def]);

  const setField = (key: string, value: unknown) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const apply = () => {
    if (!widget) return;
    onApply(widget, draft);
    onOpenChange(false);
  };

  const open = Boolean(widget);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        size="default"
        className="flex flex-col"
        aria-label="Configure widget"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" aria-hidden />
            {def ? def.title : 'Configure widget'}
          </SheetTitle>
          <SheetDescription>
            {def ? def.description : 'Adjust this widget.'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6">
          {fields.map((f) => {
            const value = draft[f.key];
            const choices = f.choices ?? [];
            if (f.kind === 'select' && choices.length) {
              return (
                <Field key={f.key} label={f.label} description={f.placeholder}>
                  {({ id }) => (
                    <Select
                      value={typeof value === 'string' ? value : ''}
                      onValueChange={(v) => setField(f.key, v)}
                    >
                      <SelectTrigger id={id}>
                        <SelectValue placeholder={f.placeholder ?? 'Select…'} />
                      </SelectTrigger>
                      <SelectContent>
                        {choices.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              );
            }
            // Default: a plain-text input (title override + any free-text option). The
            // value is stored as a plain string (#9).
            return (
              <Field key={f.key} label={f.label} description={f.placeholder}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={typeof value === 'string' ? value : ''}
                    placeholder={f.placeholder}
                    maxLength={120}
                    onChange={(e) => setField(f.key, e.target.value)}
                  />
                )}
              </Field>
            );
          })}
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={apply}>
            Apply
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export default WidgetConfigSheet;
