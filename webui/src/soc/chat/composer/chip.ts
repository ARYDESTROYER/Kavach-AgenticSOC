/**
 * The composer's one chip grammar (SPEC §10.4): a quiet 28 px control inside the 32 px
 * row — hairline border, muted text, token colours only. Shared by the Read-only lock,
 * the Scope chip, removable @-scope chips and the model chip so they line up exactly.
 */
import { focusRing } from '@/lib/ui-recipes';

/** A clickable chip (button). */
export const chipButton =
  'inline-flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-sm border border-border bg-transparent px-2 ' +
  'text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ' +
  'data-[state=open]:bg-muted data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-50 ' +
  '[&_svg]:size-3.5 [&_svg]:shrink-0 ' +
  focusRing;

/** A static chip that holds a label and a remove button. */
export const chipStatic =
  'inline-flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1 rounded-sm border border-border bg-muted/40 pl-2 pr-0.5 ' +
  'text-xs text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0';

/** The 24×24 remove target inside {@link chipStatic}. */
export const chipRemove =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-muted-foreground transition-colors ' +
  'hover:bg-muted hover:text-foreground ' +
  focusRing;
