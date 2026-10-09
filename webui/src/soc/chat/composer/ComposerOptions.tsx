/**
 * Options ⋯ (SPEC §10.4): Model, "Type out answers", Saved prompts and Keyboard
 * shortcuts in one Radix menu; the compact Case Manager composer shows Model and
 * Type out answers only.
 *
 * "Type out answers" is the D2 live-mode preference (`engine.streamMode`): a
 * `menuitemcheckbox` drawn as a switch, with the exact helper copy, and disabled with
 * the reason when the server cannot stream text for this model or the operator turned
 * it off. A non-default model also shows as a removable chip ({@link ModelChip}).
 */
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Bookmark, BookmarkPlus, Cpu, Ellipsis, Keyboard, ListChecks, X } from 'lucide-react';
import type { ChatContextInfo, ChatPrompt, ChatStreamMode } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import {
  DropdownMenu,
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
import { CHAT_KEYSHORTCUTS } from '../shortcuts/useChatShortcuts';
import { shortcutLabel } from '../shortcuts/shortcut-list';
import { displayText } from '../stream-events';
import { chipRemove, chipStatic } from './chip';
import type { CatalogState, ModelOption } from './useComposerCatalog';
import type { SavedPromptsController } from './SavedPrompts';

/** The exact helper copy (SPEC §10.4). */
export const TYPE_OUT_HELPER =
  'Steps and token counts are always live. With this on, the final answer appears word by word.';

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
  onManagePrompts?: () => void;
  onOpenShortcuts?: () => void;
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
    onManagePrompts,
    onOpenShortcuts,
  } = props;
  const typeOutReason = typeOutUnavailableReason(context);
  const typeOutOn = streamMode === 'text' && !typeOutReason;
  const helperId = React.useId();
  const titleId = React.useId();
  const workspace = variant === 'workspace';

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    if (canChooseModel) loadModels();
    prompts?.load();
  };

  const modelLabel = model ? displayText(model, 40) : 'Default';
  // The default is listed once, as "Default model" (with its name when known).
  const defaultName = displayText(defaultModel ?? (model ? '' : (context?.model ?? '')), 60);
  const otherModels = defaultModel ? models.filter((option) => option.value !== defaultModel) : models;

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
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
      <DropdownMenuContent side="top" align="end" className="w-72">
        {canChooseModel ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1">Model</span>
              <span className="max-w-[8rem] truncate text-xs text-muted-foreground">{modelLabel}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
              <DropdownMenuRadioGroup
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
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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

        {workspace ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Bookmark className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">Saved prompts</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
                {prompts?.state === 'loading' ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
                {prompts?.state === 'error' ? (
                  <DropdownMenuItem disabled>{prompts.error ?? 'Saved prompts could not be loaded.'}</DropdownMenuItem>
                ) : null}
                {prompts?.state === 'ready' && prompts.prompts.length === 0 ? (
                  <DropdownMenuItem disabled>No saved prompts yet</DropdownMenuItem>
                ) : null}
                {prompts?.prompts.map((prompt) => (
                  <DropdownMenuItem key={prompt.id} onSelect={() => onUsePrompt?.(prompt)}>
                    <span className="min-w-0 flex-1 truncate">{prompt.title}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!draft.trim()} onSelect={() => onSaveCurrent?.()}>
                  <BookmarkPlus aria-hidden="true" />
                  Save current prompt
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onManagePrompts?.()}>
                  <ListChecks aria-hidden="true" />
                  Manage saved prompts…
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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
