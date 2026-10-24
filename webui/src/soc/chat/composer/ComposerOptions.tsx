/**
 * Options ⋯ (SPEC §10.4): Model, "Type out answers", Prompts and Keyboard shortcuts in
 * one Radix menu; the compact Case Manager composer shows Model and Type out answers
 * only. Prompts (Round 12 prompt library) lists the analyst's favorites (else their
 * first saved prompts), Save current prompt and the Prompt library.
 *
 * "Type out answers" is the D2 live-mode preference (`engine.streamMode`): a
 * `menuitemcheckbox` drawn as a switch, with the exact helper copy, and disabled with
 * the reason when the server cannot stream text for this model or the operator turned
 * it off. A non-default model also shows as a removable chip ({@link ModelChip}).
 *
 * Round 13 (SPEC-chat T25): the helper is one line ("Shows the answer as it is
 * written."); two personal checkboxes, "Suggestions when a chat starts" and "Suggested
 * follow-ups", write `UserPrefs.misc.chat_suggest_start` / `chat_suggest_follow_ups` as
 * booleans through the prefs provider (absent means on); and the Options tooltip never
 * opens while a composer menu or popover is open, nor when the menu hands focus back
 * to ⋯ on close (it used to pop up over the meter card after Esc). How long that hold
 * lasts depends on where the mouse was when the menu closed ({@link TipHold}).
 *
 * On a phone-width viewport (below Tailwind `sm`) a submenu has no room beside the
 * 288 px menu on either side, so Model and Prompts are listed inline under their own
 * labels instead of as submenus (Radix keeps a submenu on its side and would push it
 * past the screen edge). Every layer keeps a 16 px gap from the screen edges.
 */
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Bookmark, BookmarkPlus, Cpu, Ellipsis, Keyboard, Library, ListOrdered, Star, X } from 'lucide-react';
import type { ChatContextInfo, ChatPrompt, ChatStreamMode } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { useOptionalPrefs } from '@/soc/prefs';
import { useMediaQuery } from '@/soc/hooks/useMediaQuery';
import { CHAT_KEYSHORTCUTS, anyLayerOpen } from '../shortcuts/useChatShortcuts';
import { shortcutLabel } from '../shortcuts/shortcut-list';
import { displayText } from '../stream-events';
import { chipRemove, chipStatic } from './chip';
import type { CatalogState, ModelOption } from './useComposerCatalog';
import type { SavedPromptsController } from './SavedPrompts';
import { isPromptbook, orderPrompts } from './prompt-library';
import { BOTTOM_FADE, useMoreBelow } from './useMoreBelow';

/** How many of the analyst's prompts the Prompts submenu lists. */
const MENU_PROMPTS = 8;

/**
 * Below Tailwind `sm` a 288 px submenu fits on neither side of the 288 px menu, so
 * Model and Prompts are listed inline in the menu itself.
 */
export const INLINE_SUBMENUS_QUERY = '(max-width: 639.98px)';

/** Every composer layer keeps this gap from the screen edges (SPEC-chat T23, audit C8). */
export const LAYER_EDGE_GAP = 16;

/** The exact helper copy (SPEC-chat T25; was SPEC §10.4's two sentences). */
export const TYPE_OUT_HELPER = 'Shows the answer as it is written.';

/** The personal suggestion switches (SPEC-chat T25), as `UserPrefs.misc` keys and labels. */
export const SUGGESTION_SWITCHES = [
  { key: 'chat_suggest_start', label: 'Suggestions when a chat starts' },
  { key: 'chat_suggest_follow_ups', label: 'Suggested follow-ups' },
] as const;

export type SuggestionSwitchKey = (typeof SUGGESTION_SWITCHES)[number]['key'];

/** On unless the viewer's stored value is exactly `false` (absent means on). */
export function suggestionOn(misc: Record<string, unknown> | null | undefined, key: SuggestionSwitchKey): boolean {
  return misc?.[key] !== false;
}

/** Why "Type out answers" cannot be turned on, or null when it can. */
export function typeOutUnavailableReason(context: ChatContextInfo | null): string | null {
  if (!context || context.text_streaming.available) return null;
  if (context.text_streaming.reason === 'disabled_by_admin') return 'Turned off by your administrator.';
  if (context.text_streaming.reason === 'model_does_not_stream') return "The selected model can't type out answers.";
  return 'Not available right now.';
}

const DEFAULT_MODEL = '__default__';

export interface ComposerOptionsProps {
  variant: 'workspace' | 'case';
  context: ChatContextInfo | null;
  model: string | null;
  setModel: (model: string | null) => void;
  /** The configured default model: listed once, as "Default model", never twice. */
  defaultModel?: string | null;
  streamMode: ChatStreamMode;
  setStreamMode: (mode: ChatStreamMode) => void;
  /** The caller may pick a non-default model (`models:read`). */
  canChooseModel: boolean;
  models: ModelOption[];
  modelsState: CatalogState;
  loadModels: () => void;
  prompts?: SavedPromptsController;
  draft?: string;
  onUsePrompt?: (prompt: ChatPrompt) => void;
  onSaveCurrent?: () => void;
  /** Open the prompt library. */
  onOpenLibrary?: () => void;
  onOpenShortcuts?: () => void;
  /**
   * The menu closed: by default focus returns to ⋯. The composer prevents that when a
   * chosen prompt opened its values card (focus belongs in the card) or filled the field.
   */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Why the Options tooltip is held back after the menu closes.
 * - `until-leave`: the mouse was over ⋯ (Esc or a second click on ⋯ while resting on
 *   it). The browser sends ⋯ a fresh `pointerenter` without any movement when the menu
 *   gives the page its pointer events back, so only a real leave (or blur) ends it.
 * - `until-hover`: the mouse was elsewhere (an outside click, a menu item, the keyboard).
 *   Only the focus hand-back is held; the next arrival on ⋯ is a deliberate hover.
 */
type TipHold = 'none' | 'until-leave' | 'until-hover';

/** A pointer event's view of where the mouse is. */
type PointerLike = Pick<PointerEvent, 'pointerType' | 'clientX' | 'clientY' | 'target' | 'type'>;

/**
 * Whether the mouse is over `trigger`: by position when it has a layout box (during the
 * modal menu every outside event targets the root element), else by the event target.
 */
export function pointerOverTrigger(trigger: HTMLElement, event: PointerLike): boolean {
  const box = trigger.getBoundingClientRect();
  if (box.width > 0 && box.height > 0) {
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  }
  if (event.type === 'pointerleave' || event.type === 'pointerout') return false;
  return event.target instanceof Node && trigger.contains(event.target);
}

export function ComposerOptions(props: ComposerOptionsProps) {
  const {
    variant,
    context,
    model,
    setModel,
    defaultModel = null,
    streamMode,
    setStreamMode,
    canChooseModel,
    models,
    modelsState,
    loadModels,
    prompts,
    draft = '',
    onUsePrompt,
    onSaveCurrent,
    onOpenLibrary,
    onOpenShortcuts,
    onCloseAutoFocus,
  } = props;
  const typeOutReason = typeOutUnavailableReason(context);
  const typeOutOn = streamMode === 'text' && !typeOutReason;
  const helperId = React.useId();
  const titleId = React.useId();
  const workspace = variant === 'workspace';
  const prefsCtx = useOptionalPrefs();
  const misc = prefsCtx?.prefs.misc;

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [tipOpen, setTipOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  /** The menu just closed and handed focus back to ⋯: no tooltip for that ({@link TipHold}). */
  const tipHold = React.useRef<TipHold>('none');
  /** Whether the mouse was last seen over ⋯. */
  const mouseOnTrigger = React.useRef(false);
  const notePointer = React.useCallback((event: PointerLike) => {
    const trigger = triggerRef.current;
    if (trigger && event.pointerType === 'mouse') mouseOnTrigger.current = pointerOverTrigger(trigger, event);
  }, []);
  // While the menu is open the page ignores the pointer, so follow it from the document
  // (capture runs before the menu's own outside-click handling closes it).
  React.useEffect(() => {
    if (!menuOpen) return;
    const doc = triggerRef.current?.ownerDocument ?? document;
    const listener = (event: PointerEvent) => notePointer(event);
    doc.addEventListener('pointermove', listener, true);
    doc.addEventListener('pointerdown', listener, true);
    return () => {
      doc.removeEventListener('pointermove', listener, true);
      doc.removeEventListener('pointerdown', listener, true);
    };
  }, [menuOpen, notePointer]);

  const onOpenChange = (open: boolean) => {
    setMenuOpen(open);
    setTipOpen(false);
    if (!open) {
      tipHold.current = mouseOnTrigger.current ? 'until-leave' : 'until-hover';
      return;
    }
    if (canChooseModel) loadModels();
    prompts?.load();
  };
  const onTipChange = (open: boolean) => {
    // Never over an open menu, popover or the meter card, and not on the focus a closing
    // menu returns to ⋯.
    if (open && (menuOpen || tipHold.current !== 'none' || anyLayerOpen())) return;
    setTipOpen(open);
  };
  const releaseTip = () => {
    tipHold.current = 'none';
  };
  const onTriggerPointerEnter = (event: React.PointerEvent) => {
    notePointer(event.nativeEvent);
    // The mouse came to ⋯ from elsewhere: a deliberate hover. A `pointerenter` while the
    // mouse rests on ⋯ is the browser's, not the analyst's, and keeps the hold.
    if (event.pointerType === 'mouse' && tipHold.current === 'until-hover') releaseTip();
  };
  const onTriggerPointerLeave = (event: React.PointerEvent) => {
    notePointer(event.nativeEvent);
    releaseTip();
  };
  const onTriggerPointer = (event: React.PointerEvent) => notePointer(event.nativeEvent);
  const inline = useMediaQuery(INLINE_SUBMENUS_QUERY);
  const inlineModels = useMoreBelow<HTMLDivElement>();

  const modelLabel = model ? displayText(model, 40) : 'Default';
  // The default is listed once, as "Default model" (with its name when known).
  const defaultName = displayText(defaultModel ?? (model ? '' : (context?.model ?? '')), 60);
  const otherModels = defaultModel ? models.filter((option) => option.value !== defaultModel) : models;

  /** The model choices: in the Model submenu, or inline on a phone-width screen. */
  const modelChoices = (
    <>
      <DropdownMenuRadioGroup
        aria-label="Model"
        value={model ?? DEFAULT_MODEL}
        onValueChange={(value) => setModel(value === DEFAULT_MODEL ? null : value)}
      >
        <DropdownMenuRadioItem value={DEFAULT_MODEL}>
          <span className="flex-1">Default model</span>
          {defaultName ? (
            <span className="ml-2 max-w-[9rem] truncate text-xs text-muted-foreground">{defaultName}</span>
          ) : null}
        </DropdownMenuRadioItem>
        {otherModels.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value}>
            <span className="min-w-0 flex-1 truncate">{displayText(option.value, 60)}</span>
            {option.provider ? (
              <span className="ml-2 shrink-0 text-xs text-muted-foreground">{option.provider}</span>
            ) : null}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {modelsState === 'loading' ? (
        <DropdownMenuItem disabled>Loading models…</DropdownMenuItem>
      ) : modelsState === 'error' || modelsState === 'denied' ? (
        <DropdownMenuItem disabled>Models could not be listed.</DropdownMenuItem>
      ) : null}
    </>
  );

  /** The Prompts entries: in the Prompts submenu, or inline on a phone-width screen. */
  const promptChoices = (
    <>
      {prompts?.state === 'loading' ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
      {prompts?.state === 'error' ? (
        <DropdownMenuItem disabled>{prompts.error ?? 'Saved prompts could not be loaded.'}</DropdownMenuItem>
      ) : null}
      {prompts?.state === 'ready' && prompts.prompts.length === 0 ? (
        <DropdownMenuItem disabled>No saved prompts yet</DropdownMenuItem>
      ) : null}
      {(() => {
        const list = orderPrompts(prompts?.prompts ?? []);
        const favorites = list.filter((p) => p.favorite);
        const shown = (favorites.length ? favorites : list).slice(0, MENU_PROMPTS);
        if (!shown.length) return null;
        return (
          <>
            <DropdownMenuLabel className="text-2xs font-medium text-muted-foreground">
              {favorites.length ? 'Favourites' : 'Your prompts'}
            </DropdownMenuLabel>
            {shown.map((prompt) => (
              <DropdownMenuItem key={prompt.id} onSelect={() => onUsePrompt?.(prompt)}>
                {isPromptbook(prompt) ? (
                  <ListOrdered aria-hidden="true" />
                ) : prompt.favorite ? (
                  <Star aria-hidden="true" />
                ) : (
                  <Bookmark aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate">{prompt.title}</span>
              </DropdownMenuItem>
            ))}
          </>
        );
      })()}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!draft.trim()} onSelect={() => onSaveCurrent?.()}>
        <BookmarkPlus aria-hidden="true" />
        Save current prompt
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onOpenLibrary?.()}>
        <Library aria-hidden="true" />
        Prompt library…
      </DropdownMenuItem>
    </>
  );

  return (
    <DropdownMenu open={menuOpen} onOpenChange={onOpenChange}>
      <Tooltip open={tipOpen && !menuOpen} onOpenChange={onTipChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            ref={triggerRef}
            onBlur={releaseTip}
            onPointerEnter={onTriggerPointerEnter}
            onPointerMove={onTriggerPointer}
            onPointerDown={onTriggerPointer}
            onPointerLeave={onTriggerPointerLeave}
            className={cn(
              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground',
              focusRing,
            )}
            aria-label="Composer options"
          >
            <Ellipsis className="h-4 w-4" aria-hidden="true" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Options</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        collisionPadding={LAYER_EDGE_GAP}
        className="w-72"
        data-inline-submenus={inline ? '' : undefined}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          // The host kept focus away from ⋯ (a chosen prompt took it): nothing to hold back.
          if (event.defaultPrevented) releaseTip();
        }}
      >
        {canChooseModel ? (
          inline ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-2 text-2xs font-medium text-muted-foreground" data-inline-group="model">
                <Cpu className="h-4 w-4" aria-hidden="true" />
                Model
              </DropdownMenuLabel>
              {/* A long model list scrolls in its own 12rem box (fading while more is
                  below), so the rest of the menu stays in view on a phone. */}
              <div
                ref={inlineModels.ref}
                data-inline-models=""
                data-more-below={inlineModels.moreBelow ? '' : undefined}
                className={cn('max-h-48 scroll-pb-6 overflow-y-auto', inlineModels.moreBelow && BOTTOM_FADE)}
              >
                {modelChoices}
              </div>
            </>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">Model</span>
                <span className="max-w-[8rem] truncate text-xs text-muted-foreground">{modelLabel}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent collisionPadding={LAYER_EDGE_GAP} className="max-h-80 w-72 overflow-y-auto">
                {modelChoices}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        ) : (
          <DropdownMenuLabel className="flex items-center gap-2 font-normal">
            <Cpu className="h-4 w-4" aria-hidden="true" />
            <span className="flex-1">Model</span>
            <span className="max-w-[9rem] truncate">{context?.model ?? 'Default'}</span>
          </DropdownMenuLabel>
        )}

        <DropdownMenuPrimitive.CheckboxItem
          checked={typeOutOn}
          disabled={Boolean(typeOutReason)}
          onCheckedChange={(checked) => setStreamMode(checked === true ? 'text' : 'steps')}
          onSelect={(event) => event.preventDefault()}
          // Named by its title only: the helper (and any reason) is the description,
          // so a screen reader speaks it once, not as part of the name and again.
          aria-labelledby={titleId}
          aria-describedby={helperId}
          className={cn(
            'relative flex cursor-default select-none items-start gap-3 rounded-[3px] px-2.5 py-2 text-sm outline-none transition-colors',
            'focus:bg-accent focus:text-accent-foreground data-[disabled]:cursor-not-allowed',
          )}
        >
          <span className="min-w-0 flex-1">
            <span id={titleId} className={cn('block', typeOutReason ? 'text-muted-foreground' : 'text-foreground')}>
              Type out answers
            </span>
            <span id={helperId} className="mt-0.5 block text-xs text-muted-foreground">
              {TYPE_OUT_HELPER}
              {typeOutReason ? <span className="mt-0.5 block font-medium text-foreground">{typeOutReason}</span> : null}
            </span>
          </span>
          {/* A switch drawn for the eye; the item itself is the menuitemcheckbox. */}
          <span
            aria-hidden="true"
            data-state={typeOutOn ? 'checked' : 'unchecked'}
            className={cn(
              'mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
              typeOutOn ? 'bg-primary' : 'bg-input',
              typeOutReason && 'opacity-50',
            )}
          >
            <span
              className={cn(
                'block h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
                typeOutOn ? 'translate-x-4' : 'translate-x-0',
              )}
            />
          </span>
        </DropdownMenuPrimitive.CheckboxItem>

        {workspace && prefsCtx ? (
          <>
            <DropdownMenuSeparator />
            {SUGGESTION_SWITCHES.map(({ key, label }) => (
              <DropdownMenuCheckboxItem
                key={key}
                checked={suggestionOn(misc, key)}
                // Kept open: a setting, not an action.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) => prefsCtx.patchMisc({ [key]: checked === true })}
                data-suggestion-switch={key}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        ) : null}

        {workspace ? (
          <>
            <DropdownMenuSeparator />
            {inline ? (
              <>
                <DropdownMenuLabel className="flex items-center gap-2 text-2xs font-medium text-muted-foreground" data-inline-group="prompts">
                  <Bookmark className="h-4 w-4" aria-hidden="true" />
                  Prompts
                </DropdownMenuLabel>
                {promptChoices}
                <DropdownMenuSeparator />
              </>
            ) : (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Bookmark className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1">Prompts</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent collisionPadding={LAYER_EDGE_GAP} className="max-h-80 w-72 overflow-y-auto">
                  {promptChoices}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {onOpenShortcuts ? (
              <DropdownMenuItem onSelect={() => onOpenShortcuts()} aria-keyshortcuts={CHAT_KEYSHORTCUTS.openShortcuts}>
                <Keyboard aria-hidden="true" />
                Keyboard shortcuts
                <DropdownMenuShortcut>{shortcutLabel(['Mod', '/'])}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The removable non-default model chip (SPEC §10.4). `compact` (narrow composer) keeps
 * only the icon and the remove control, so a non-default — possibly pricier — model is
 * still visible and removable at every width; the name is in the accessible names and
 * the hover title.
 */
export function ModelChip({ model, onClear, compact = false }: { model: string; onClear: () => void; compact?: boolean }) {
  const name = displayText(model, 60);
  if (compact) {
    return (
      <span className={cn(chipStatic, 'pl-1.5')} title={`Model: ${name}`} data-model-chip="compact">
        <Cpu aria-hidden="true" className="text-muted-foreground" />
        <span className="sr-only">Model: {name}</span>
        <button type="button" className={chipRemove} aria-label={`Use the default model instead of ${name}`} onClick={onClear}>
          <X aria-hidden="true" />
        </button>
      </span>
    );
  }
  return (
    <span className={cn(chipStatic, 'max-w-[11rem] shrink')}>
      <Cpu aria-hidden="true" className="text-muted-foreground" />
      <span className="truncate" title={name}>
        {name}
      </span>
      <button type="button" className={chipRemove} aria-label={`Use the default model instead of ${name}`} onClick={onClear}>
        <X aria-hidden="true" />
      </button>
    </span>
  );
}
