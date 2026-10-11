/**
 * DispositionPicker — the investigative-outcome choice as a list of radio cards, each
 * with a one-line definition (Round 12, WP-CM; Sentinel / Splunk wording).
 *
 * GROUND TRUTH (G1): the picker opens EMPTY and stays empty until a person chooses. The
 * AI's suggestion is shown as a read-only hint beside the label — never a preselection,
 * never a click-to-apply — because a value the analyst did not choose must not be posted
 * back as their classification (`disposition_declared` is sent only when a person
 * operated this control). "Undetermined" is an explicit choice like any other.
 *
 * Keys 1–6 pick the matching card while focus is NOT in a text field, so the dialog can
 * be driven from the keyboard without hunting for the list.
 *
 * SECURITY (#9): every label is a fixed enum string; nothing case-derived renders here
 * except the humanised recorded value, which is plain text.
 */
import * as React from 'react';
import { Bot } from 'lucide-react';

import { cn } from '@/lib/cn';
import { humanizeToken } from '@/lib/format';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';

import { DISPOSITION_OPTIONS } from './shared';

/** One-line definitions for each disposition (sentence case, no jargon). */
export const DISPOSITION_DEFINITIONS: Record<(typeof DISPOSITION_OPTIONS)[number]['value'], string> = {
  true_positive: 'Real malicious or unwanted activity that needs a response.',
  false_positive: 'The detection fired on activity that is not malicious.',
  benign: 'Real activity that is expected or authorised, such as a sanctioned test.',
  suspicious: 'Concerning but not confirmed. Keep watching it.',
  duplicate: 'Already handled in another case.',
  undetermined: 'Not enough evidence to decide either way.',
};

/** The disposition an AI verdict points at, used ONLY as a read-only hint (G1). */
export function aiSuggestedDisposition(verdict?: string | null): string | null {
  const v = String(verdict ?? '').trim().toUpperCase();
  if (v === 'TRUE_POSITIVE') return 'true_positive';
  if (v === 'FALSE_POSITIVE') return 'false_positive';
  return null;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export interface DispositionPickerProps {
  /** The chosen value ('' while nothing is chosen). */
  value: string;
  /** Called ONLY from an analyst interaction (click, arrow keys or a 1–6 hotkey). */
  onChange: (value: string) => void;
  /** The AI verdict, shown as a read-only "AI suggested" hint when it maps to a value. */
  verdict?: string | null;
  /** The disposition already stored on the case — read-only context, never a default. */
  currentDisposition?: string | null;
  /** Enable the 1–6 hotkeys (only while the owning dialog is open). Default true. */
  hotkeys?: boolean;
  disabled?: boolean;
  /** Id prefix so two pickers on one page never share element ids. */
  idPrefix?: string;
  className?: string;
}

export const DispositionPicker: React.FC<DispositionPickerProps> = ({
  value,
  onChange,
  verdict,
  currentDisposition,
  hotkeys = true,
  disabled = false,
  idPrefix = 'disposition',
  className,
}) => {
  const labelId = `${idPrefix}-label`;
  const helpId = `${idPrefix}-help`;
  const suggested = aiSuggestedDisposition(verdict);
  const suggestedText = suggested
    ? DISPOSITION_OPTIONS.find((o) => o.value === suggested)?.text ?? null
    : null;
  const currentRaw = String(currentDisposition ?? '').trim();
  const currentText =
    currentRaw && currentRaw.toLowerCase() !== 'none' ? humanizeToken(currentRaw) : '';

  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    if (!hotkeys || disabled || typeof document === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) return;
      const index = Number.parseInt(event.key, 10);
      if (!Number.isInteger(index) || index < 1 || index > DISPOSITION_OPTIONS.length) return;
      event.preventDefault();
      onChangeRef.current(DISPOSITION_OPTIONS[index - 1].value);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hotkeys, disabled]);

  return (
    <div className={cn('space-y-2', className)} data-testid="disposition-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={labelId} className="text-sm font-medium text-foreground">
          Disposition <span className="font-normal text-muted-foreground">(required)</span>
        </span>
        {suggestedText ? (
          <span
            data-testid="disposition-ai-hint"
            className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            <Bot className="size-3 text-primary" aria-hidden />
            AI suggested: {suggestedText}
          </span>
        ) : null}
      </div>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next)}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        aria-required
        disabled={disabled}
        className="gap-1.5"
      >
        {DISPOSITION_OPTIONS.map((option, index) => {
          const id = `${idPrefix}-${option.value}`;
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors duration-fast',
                checked
                  ? 'border-primary bg-primary/[0.06]'
                  : 'border-border hover:bg-muted/60',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <RadioGroupItem id={id} value={option.value} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{option.text}</span>
                  <kbd
                    aria-hidden
                    className="shrink-0 rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground"
                  >
                    {index + 1}
                  </kbd>
                </span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  {DISPOSITION_DEFINITIONS[option.value]}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
        {currentText
          ? `Currently recorded: ${currentText}. Pick the outcome you are confirming; your choice is what is stored as the analyst's.`
          : 'Pick the outcome you are confirming; your choice is what is stored as the analyst’s.'}
      </p>
    </div>
  );
};

export default DispositionPicker;
