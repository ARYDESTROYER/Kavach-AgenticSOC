/**
 * TagInput: chip entry for tags / rule allowlists / IOC lists (DESIGN_STANDARD
 * §5.2). Type a value + Enter (or comma) to add a chip; Backspace on an empty
 * field removes the last chip; each chip has a ≥24px remove target (IconButton).
 *
 * Contract:
 *  - controlled `value: string[]` + `onChange(next)`.
 *  - de-dupes (case-insensitive by default) and trims; empties are ignored.
 *  - only Enter or a delimiter adds a chip. Text that is typed but not added is
 *    NEVER added on its own (not on blur, not when a form is submitted): it stays in
 *    the field with an inline "Not added yet" hint. A form that would lose it on
 *    submit sets `pendingBlocked` (see `inputValue`) so the hint turns into an error
 *    that asks the person to add it or clear it.
 *  - `maxLength` refuses a longer value with an inline message. It is never cut to
 *    fit (no `maxLength` attribute either, which would cut a paste silently).
 *  - `validate(tag)` may reject a tag (return an error string), shown inline; the
 *    tag is NOT added.
 *  - `max` caps the number of chips; the input is disabled at the cap (unless it still
 *    holds typed text, which then reads as an error so it can be cleared).
 *  - the line under the field (the pending hint, a refusal, the blocked-submit error)
 *    is kept on screen: while the person types and when a submit flags the field, the
 *    whole field scrolls into view (`nearest`); a form that stops sends focus with
 *    `focusTagInput`, which does the same. A focused input that is itself on screen
 *    does not scroll its container, so in a scroll area that ends just below it (the
 *    close dialog at 1440x900) the message sat out of view and a blocked Close looked
 *    like it did nothing.
 *  - a11y: the field is a `Field`-labelled input; chips are a `role="list"`; each
 *    remove button is labelled "Remove {tag}"; the pending hint is part of the
 *    input's description. Values render as plain text (#9).
 */
import * as React from 'react';
import { X } from 'lucide-react';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { cn } from '@/lib/cn';
import { tagTooLongMessage } from '@/lib/tags';

/** The inline hint while typed text is not a chip yet. */
export const TAG_PENDING_HINT = 'Not added yet. Press Enter to add it.';
/** The same hint when a submit found the text still pending (rendered as an error). */
export const TAG_PENDING_BLOCKED = 'Not added yet. Press Enter to add it, or clear the field.';

/** Typed text when the field already holds `max` entries (rendered as an error). */
export const TAG_FULL_PENDING = 'No room for another one. Remove one to add this, or clear the field.';

/** The scroll margin a TagInput field carries (the gap kept when it scrolls into view). */
export const TAG_FIELD_SCROLL_MARGIN = 'scroll-my-4';

/**
 * Scroll a TagInput field (label, input and the line under it) into view, the least
 * distance needed. A no-op when it is already in view.
 */
function revealTagField(field: HTMLElement | null): void {
  field?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Send focus to a TagInput whose form just stopped, and bring its whole field into
 * view. A plain `focus()` is not enough: it does not scroll an input that is already on
 * screen or already focused, so the message under it could stay out of view. (A message
 * that is new on this render is revealed by the field itself once it renders.)
 */
export function focusTagInput(input: HTMLInputElement | null): void {
  if (!input) return;
  input.focus();
  revealTagField(input.closest<HTMLElement>('[data-tag-field]'));
}

export interface TagInputProps {
  /** Visible label. */
  label: React.ReactNode;
  /** Extra label classes (a dense dialog sets its labels at `text-xs`). */
  labelClassName?: string;
  /** Optional helper text. */
  description?: React.ReactNode;
  /** Controlled tag list. */
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Case-insensitive de-dupe. Default true. */
  dedupe?: boolean;
  /** Max chips. */
  max?: number;
  /** Longest value, in characters. A longer one is refused with a message, never cut. */
  maxLength?: number;
  /** Reject a candidate tag; return an error message to block it. */
  validate?: (tag: string) => string | null | undefined;
  /**
   * The text typed but not added yet, when the parent needs to see it (a form that
   * must not submit while it is pending). Omit for an internal draft.
   */
  inputValue?: string;
  onInputValueChange?: (text: string) => void;
  /** A submit found pending text: show the hint as an error asking to add or clear it. */
  pendingBlocked?: boolean;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  /** Keys (besides Enter) that commit the current text. Default [',']. */
  delimiters?: string[];
}

export const TagInput = React.forwardRef<HTMLInputElement, TagInputProps>(
  (
    {
      label,
      labelClassName,
      description,
      value,
      onChange,
      placeholder,
      dedupe = true,
      max,
      maxLength,
      validate,
      inputValue,
      onInputValueChange,
      pendingBlocked,
      required,
      disabled,
      className,
      delimiters = [','],
    },
    ref,
  ) => {
    const [ownText, setOwnText] = React.useState('');
    const text = inputValue ?? ownText;
    const setText = (next: string) => {
      if (inputValue === undefined) setOwnText(next);
      onInputValueChange?.(next);
    };
    const [error, setError] = React.useState<string | null>(null);
    const [focused, setFocused] = React.useState(false);
    const hintId = React.useId();
    const fieldRef = React.useRef<HTMLDivElement | null>(null);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const setInputRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const atMax = max != null && value.length >= max;
    const pending = text.trim();
    // Validated as it is typed (Apple: validate inline, not on submit).
    const lengthError = maxLength != null && pending ? tagTooLongMessage(pending, maxLength) : null;
    // At the cap, typed text cannot be added: say so (the field stays editable while it
    // holds text, so the text can be cleared rather than stranded in a disabled input).
    const fullError = atMax && pending ? TAG_FULL_PENDING : null;
    const fieldError =
      lengthError ?? error ?? fullError ?? (pendingBlocked && pending ? TAG_PENDING_BLOCKED : null);
    const showHint = Boolean(pending) && !fieldError;
    /** The line under the field, if any: an error, else the pending hint. */
    const message = fieldError ?? (showHint ? TAG_PENDING_HINT : null);

    // Keep that line on screen while the person is in the field (each edit) and when a
    // submit flags the field. `nearest` does nothing when the field is already in view.
    React.useEffect(() => {
      if (!message) return;
      const inField = typeof document !== 'undefined' && document.activeElement === inputRef.current;
      if (inField || pendingBlocked) revealTagField(fieldRef.current);
    }, [text, message, pendingBlocked]);

    const add = (raw: string) => {
      const tag = raw.trim();
      if (!tag) return;
      if (atMax) return;
      if (maxLength != null && tagTooLongMessage(tag, maxLength)) return; // already shown
      if (dedupe && value.some((v) => v.toLowerCase() === tag.toLowerCase())) {
        setText('');
        return;
      }
      const err = validate?.(tag);
      if (err) {
        setError(err);
        return;
      }
      setError(null);
      onChange([...value, tag]);
      setText('');
    };

    const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

    return (
      <Field
        ref={fieldRef}
        label={label}
        labelClassName={labelClassName}
        description={description}
        error={fieldError ?? undefined}
        required={required}
        // Room around the field when it scrolls into view, so its last line does not sit
        // flush against a scroll area's edge (a dialog footer, the top bar).
        className={cn(TAG_FIELD_SCROLL_MARGIN, className)}
        data-tag-field=""
      >
        {({ id, describedBy, invalid }) => (
          <>
            <div
              className={cn(
                'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 transition-colors',
                // ONE control-wide keyboard-focus treatment on the composite container
                // (not doubled onto the inner <input>, which floated an inset ring).
                'focus-within:ring-2 focus-within:ring-ring/60 focus-within:ring-offset-2 focus-within:ring-offset-background',
                fieldError ? 'border-critical' : 'border-input focus-within:border-ring hover:border-border-strong',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {/* role="list" is kept intentionally: `display:contents` (the
                  `contents` class) strips implicit list semantics in several
                  browsers, so the explicit role restores them. */}
              {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
              <ul role="list" className="contents">
                {value.map((tag, i) => (
                  <li
                    key={`${tag}-${i}`}
                    className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-foreground"
                  >
                    <span>{tag}</span>
                    <IconButton
                      label={`Remove ${tag}`}
                      size="sm"
                      tooltip={false}
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => removeAt(i)}
                      className="h-4 w-4 [&_svg]:size-3"
                    >
                      <X />
                    </IconButton>
                  </li>
                ))}
              </ul>
              {/* Labeled via Field's <label htmlFor={id}>; the association crosses the
                  render-prop boundary so the linter can't see it statically. */}
              {/* eslint-disable-next-line jsx-a11y/control-has-associated-label */}
              <input
                ref={setInputRef}
                id={id}
                type="text"
                value={text}
                disabled={disabled || (atMax && !pending)}
                placeholder={atMax ? undefined : placeholder}
                aria-describedby={[showHint ? hintId : null, describedBy].filter(Boolean).join(' ') || undefined}
                aria-invalid={invalid}
                onChange={(e) => {
                  setError(null);
                  setText(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || delimiters.includes(e.key)) {
                    e.preventDefault();
                    add(text);
                  } else if (e.key === 'Backspace' && text === '' && value.length) {
                    removeAt(value.length - 1);
                  }
                }}
                // No commit on blur: leaving the field (or submitting the form) must not
                // turn half-typed text into a tag. The hint below says it is pending, in
                // the warning tone once focus has left it behind.
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                className="h-6 min-w-[6rem] flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            {showHint ? (
              <p
                id={hintId}
                data-testid="tag-input-pending"
                className={cn('text-xs', focused ? 'text-muted-foreground' : 'text-warning-text')}
              >
                {TAG_PENDING_HINT}
              </p>
            ) : null}
          </>
        )}
      </Field>
    );
  },
);
TagInput.displayName = 'TagInput';

/**
 * The typed-but-not-added text of a TagInput inside a form that must not submit while
 * text is pending. Spread `bind` onto the TagInput. `settled()` is true when nothing is
 * pending; otherwise it flags the field ("Not added yet. Press Enter to add it, or clear
 * the field."), focuses it, scrolls it into view and returns false, and the form stops
 * instead of saving the text silently or dropping it. `reset()` clears the text after a
 * successful save.
 */
export function usePendingTagDraft() {
  const [text, setText] = React.useState('');
  const [blocked, setBlocked] = React.useState(false);
  const ref = React.useRef<HTMLInputElement | null>(null);
  const settled = React.useCallback((): boolean => {
    if (!text.trim()) return true;
    setBlocked(true);
    focusTagInput(ref.current);
    return false;
  }, [text]);
  const reset = React.useCallback(() => {
    setText('');
    setBlocked(false);
  }, []);
  const onInputValueChange = React.useCallback((next: string) => {
    setText(next);
    setBlocked(false);
  }, []);
  return {
    text,
    settled,
    reset,
    bind: { ref, inputValue: text, onInputValueChange, pendingBlocked: blocked },
  };
}
