/**
 * Composer — the chat input (SPEC §10.4, §10.4a, §8 meter).
 *
 * Workspace variant: a textarea plus ONE 32 px control row (≤ 88 px at rest):
 *   left  — Read-only lock chip (tooltip + access popover), Scope chip ("<source> ·
 *           24h"), removable @-scope chips, the removable non-default model chip;
 *   right — "≈ 1.2k" estimate + budget ring (hover card), Options ⋯, Send ↔ Stop.
 * Below 560 px of composer width the Scope and @ chips merge into "Scope · n" and the
 * lock chip keeps only its icon. The compact Case Manager variant is the textarea,
 * the estimate, Options (Model, Type out answers) and Send/Stop on one line.
 *
 * Keyboard: Enter sends, Shift+Enter adds a line, nothing fires while an input method
 * composes (isComposing / keyCode 229). While a turn runs the textarea stays editable,
 * Enter does nothing and Send becomes Stop; Esc stops the turn only when focus is in
 * the composer and no menu, popover, sheet or dialog is open (a Radix layer closing on
 * Esc marks the event handled first). ↑ in an empty composer brings back the last
 * prompt. `/` at the start opens commands and saved prompts; `@` opens the scopes.
 * In those menus only Enter chooses: Tab keeps its focus-navigation meaning, so it can
 * never send a command turn or add a scope by accident. The case variant has no menus
 * and its placeholder does not mention them.
 *
 * Drafts live in the engine (per thread, owned by the host). The composer never
 * stores message text anywhere else.
 */
import * as React from 'react';
import { ArrowUp, Lock, Square } from 'lucide-react';
import type { ChatContextInfo, ChatPrompt } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { useAnnouncer } from '@/soc/components/announcer';
import type { ChatEngine } from '../useChatEngine';
import { anyLayerOpen } from '../shortcuts/useChatShortcuts';
import { AccessPopover } from './AccessPopover';
import { chipButton } from './chip';
import {
  atMenuGroups,
  parseAtQuery,
  parseSlashQuery,
  removeAtToken,
  slashAction,
  slashMenuGroups,
  type ComposerMenuItem,
} from './commands';
import { ComposerMenu } from './ComposerMenu';
import { ComposerOptions, ModelChip } from './ComposerOptions';
import { budgetSendBlockReason, SCOPE_LABELS } from './format';
import { ManagePromptsDialog, SavePromptDialog, useSavedPrompts } from './SavedPrompts';
import { ScopeControls } from './ScopeControls';
import { TokenMeter, type ConversationTotals } from './TokenMeter';
import { useAutoGrow } from './useAutoGrow';
import { sourcesReadable, useComposerCatalog } from './useComposerCatalog';
import { useElementWidth } from './useElementWidth';

export interface ComposerHandle {
  /** Move focus into the textarea (Shift+Esc, New chat, thread switch). */
  focus: () => void;
  /** Replace the draft and focus (e.g. "Save prompt" → edit, ↑ edit-last handled inside). */
  setText: (text: string) => void;
  /** Open the Save prompt dialog with `text` (a past user turn's "Save prompt"). */
  savePrompt: (text: string) => void;
}

export interface ComposerProps {
  engine: ChatEngine;
  /** `/chat/context` (meter, tools for / and @ menus, bounds, budget); null while loading. */
  context: ChatContextInfo | null;
  /** 'workspace' = full composer; 'case' = the compact Case Manager composer (§10.4). */
  variant?: 'workspace' | 'case';
  /** Why sending is impossible right now (thread restoring, history unavailable). */
  disabledReason?: string | null;
  /** Options ⋯ → Keyboard shortcuts. */
  onOpenShortcuts?: () => void;
  className?: string;
  /**
   * The textarea gained focus: wire `useChatContext().revalidate` here so the meter
   * re-reads a context older than 30 s (SPEC §8 "refetches on composer focus").
   */
  onComposerFocus?: () => void;
  /** This conversation's recorded totals, for the meter's hover card. */
  conversationTotals?: ConversationTotals | null;
  /**
   * The caller may pick a non-default model (`models:read`). Defaults to "the context
   * carries money fields", which the server sends only with `models:read`.
   */
  canChooseModel?: boolean;
  /**
   * `/chat/context` failed and nothing is cached (`useChatContext().error`). The access
   * popover then says so with a Retry instead of "Checking…" forever.
   */
  contextError?: string | null;
  /** Retry `/chat/context` (`useChatContext().refresh`). */
  onRetryContext?: () => void;
}

/** SPEC §10.4 placeholder. */
export const COMPOSER_PLACEHOLDER = 'Ask about your data or this app. / for commands, @ to scope';
/**
 * The same grammar, short enough for one line in a narrow composer. Chromium sizes a
 * `field-sizing: content` field from its placeholder, so the long one would wrap to
 * two lines below about 450 px and break the 88 px resting height (SPEC §10.4).
 */
export const COMPOSER_PLACEHOLDER_NARROW = 'Ask… / for commands, @ to scope';
/** The compact Case Manager composer has no `/` or `@` menus, so it never advertises them. */
export const CASE_COMPOSER_PLACEHOLDER = 'Ask about this case';
/** The Read-only chip's tooltip (SPEC §10.4, exact). */
export const READ_ONLY_TOOLTIP =
  'Searches logs, cases, metrics, intel and the help docs. It cannot change anything. Answers can be wrong; log content is untrusted data.';
/** Below this composer width the Scope and @ chips merge (SPEC §10.4). */
export const COMPOSER_NARROW_PX = 560;
/** Beyond this many @-scopes the chips also merge, so the 32 px row never overflows. */
const MAX_INLINE_SCOPE_CHIPS = 3;
/** Textarea growth cap before it scrolls (about nine lines). */
const MAX_TEXTAREA_PX = 240;

const isComposingEvent = (event: React.KeyboardEvent) =>
  event.nativeEvent.isComposing || event.keyCode === 229;

export const Composer = React.forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    engine,
    context,
    variant = 'workspace',
    disabledReason = null,
    onOpenShortcuts,
    className,
    onComposerFocus,
    conversationTotals = null,
    contextError = null,
    onRetryContext,
  } = props;
  const isCase = variant === 'case';
  const announce = useAnnouncer();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const width = useElementWidth(rootRef);
  const catalog = useComposerCatalog({ loadSources: !isCase, canReadSources: sourcesReadable(context) });
  const prompts = useSavedPrompts();
  const inputId = React.useId();
  const hintId = React.useId();
  const reasonId = React.useId();

  const [focused, setFocused] = React.useState(false);
  const [caret, setCaret] = React.useState(0);
  const [dismissedDraft, setDismissedDraft] = React.useState<string | null>(null);
  const [active, setActive] = React.useState('');
  const [listId, setListId] = React.useState<string | undefined>(undefined);
  const [activeId, setActiveId] = React.useState<string | undefined>(undefined);
  const [accessOpen, setAccessOpen] = React.useState(false);
  const [saveText, setSaveText] = React.useState<string | null>(null);
  const [manageOpen, setManageOpen] = React.useState(false);
  const pendingSelection = React.useRef<[number, number] | null>(null);

  const draft = engine.draft;
  const running = engine.busy;
  const blockReason = disabledReason || budgetSendBlockReason(context);
  const canSend = !running && !blockReason && draft.trim().length > 0;
  const canChooseModel =
    props.canChooseModel ?? Boolean(context && (context.rates || context.budget || context.simulated !== null));
  const narrow = width !== null && width < COMPOSER_NARROW_PX;
  const merged = narrow || engine.scopes.length > MAX_INLINE_SCOPE_CHIPS;

  // The width is an input so the JS fallback re-measures when the lane reflows
  // (rail toggled, report split opened) and not only on the next keystroke.
  useAutoGrow(textareaRef, draft, { maxHeight: MAX_TEXTAREA_PX, width });

  /* ---------------------------------------------------------------- menus -- */
  const slash = isCase ? null : parseSlashQuery(draft);
  // Without a catalogue every scope would read as denied: the @ menu waits for it.
  const at = isCase || slash || !context ? null : parseAtQuery(draft, caret);
  const groups = React.useMemo(() => {
    if (slash) return slashMenuGroups(slash, context, prompts.prompts);
    if (at) return atMenuGroups(at, context, engine.scopes);
    return [];
    // `slash`/`at` are re-derived from draft/caret each render; key on their inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, caret, context, prompts.prompts, engine.scopes, isCase]);
  const items = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const enabled = React.useMemo(
    () => items.filter((item) => !(item.kind === 'scope' && item.disabled)).map((item) => item.value),
    [items],
  );
  // A dismissed menu stays closed only for the draft it was dismissed on: clearing
  // the composer and typing "/" again must reopen it.
  React.useEffect(() => {
    if (dismissedDraft !== null && draft !== dismissedDraft) setDismissedDraft(null);
  }, [draft, dismissedDraft]);
  const menuKind: 'slash' | 'at' | null = slash ? 'slash' : at ? 'at' : null;
  const menuOpen = Boolean(menuKind) && items.length > 0 && focused && dismissedDraft !== draft;
  const activeValue = enabled.includes(active) ? active : (enabled[0] ?? '');

  // Load saved prompts the first time `/` is typed (never at mount).
  const slashActive = Boolean(slash);
  const loadPrompts = prompts.load;
  React.useEffect(() => {
    if (slashActive) loadPrompts();
  }, [slashActive, loadPrompts]);

  const onListRendered = React.useCallback(
    (list: HTMLElement | null) => {
      const nextList = list?.id || undefined;
      const option = activeValue
        ? (list?.querySelector<HTMLElement>(`[cmdk-item][data-value="${activeValue}"]`) ?? null)
        : null;
      setListId((prev) => (prev === nextList ? prev : nextList));
      setActiveId((prev) => (prev === (option?.id || undefined) ? prev : option?.id || undefined));
    },
    [activeValue],
  );

  /* -------------------------------------------------------- draft & caret -- */
  const focusTextarea = React.useCallback(() => textareaRef.current?.focus(), []);

  const replaceDraft = React.useCallback(
    (text: string, selection: [number, number] | null = null) => {
      pendingSelection.current = selection ?? [text.length, text.length];
      engine.setDraft(text);
      focusTextarea();
    },
    [engine, focusTextarea],
  );

  // Apply a pending selection once the host has committed the new draft.
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    const selection = pendingSelection.current;
    if (!el || !selection || el.value !== draft) return;
    pendingSelection.current = null;
    el.setSelectionRange(selection[0], selection[1]);
    setCaret(selection[1]);
  }, [draft]);

  React.useImperativeHandle(
    ref,
    () => ({
      focus: focusTextarea,
      setText: (text: string) => replaceDraft(text),
      savePrompt: (text: string) => setSaveText(text),
    }),
    [focusTextarea, replaceDraft],
  );

  /* -------------------------------------------------------------- actions -- */
  const submit = () => {
    if (!canSend) return;
    engine.send();
    focusTextarea();
  };

  const choose = (item: ComposerMenuItem) => {
    if (item.kind === 'scope') {
      if (item.disabled || !at) return;
      const next = removeAtToken(draft, at);
      engine.setScopes([...engine.scopes, item.access.scope]);
      replaceDraft(next.text, [next.caret, next.caret]);
      announce(`Limited to ${SCOPE_LABELS[item.access.scope]}`);
      return;
    }
    const action = slashAction(item);
    if (!action) return;
    if (action.type === 'send') {
      if (!running && !blockReason && engine.send(action.text, { origin: 'command' })) {
        engine.setDraft('');
        focusTextarea();
        return;
      }
      // Cannot send now (a turn runs, or sending is blocked): keep the question.
      replaceDraft(action.text);
      return;
    }
    replaceDraft(action.expansion.text, action.expansion.selection);
  };

  const insertPrompt = (prompt: ChatPrompt) => replaceDraft(prompt.text);

  const moveActive = (delta: number) => {
    if (!enabled.length) return;
    const index = enabled.indexOf(activeValue);
    const next = (index + delta + enabled.length) % enabled.length;
    setActive(enabled[next]);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingEvent(event)) return;
    const mod = event.ctrlKey || event.metaKey || event.altKey;
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      // Only Enter chooses. Tab is focus navigation: it must move on to Send or
      // Options, never send a command turn or add a scope (the menu closes on blur).
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const item = items.find((i) => i.value === activeValue);
        // With only denied scopes listed, Enter must not send the half-typed "@word".
        if (item) choose(item);
        return;
      }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        setDismissedDraft(draft);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      // Enter never inserts a line: it sends, or does nothing while a turn runs or
      // sending is blocked. A blocked Enter on a real draft says why, so the key is
      // never silently dead (the reason is also the field's description).
      event.preventDefault();
      if (!running && blockReason && draft.trim()) announce(blockReason);
      submit();
      return;
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !mod && draft === '' && engine.lastUserPrompt) {
      event.preventDefault();
      replaceDraft(engine.lastUserPrompt);
    }
  };

  // Esc stops a running turn only from inside the composer with no layer open.
  const onRootKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.shiftKey || event.defaultPrevented || isComposingEvent(event)) return;
    const root = rootRef.current;
    if (!root || !root.contains(document.activeElement)) return;
    if (menuOpen || anyLayerOpen()) return;
    if (engine.busy && engine.canStop) {
      event.preventDefault();
      engine.stop();
    }
  };

  const syncCaret = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const position = event.currentTarget.selectionStart ?? 0;
    setCaret((prev) => (prev === position ? prev : position));
  };

  /* ------------------------------------------------------------- controls -- */
  const sendStop = running ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-input bg-card text-foreground',
            'transition-colors hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
            focusRing,
          )}
          aria-label="Stop"
          aria-keyshortcuts="Escape"
          aria-disabled={!engine.canStop || undefined}
          onClick={() => {
            if (engine.canStop) engine.stop();
            focusTextarea();
          }}
        >
          <Square className="h-3 w-3 fill-current" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{engine.canStop ? 'Stop (Esc)' : "This answer can't be stopped"}</TooltipContent>
    </Tooltip>
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground',
            'transition-colors hover:bg-primary/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-40',
            focusRing,
          )}
          aria-label="Send"
          aria-keyshortcuts="Enter"
          aria-disabled={!canSend || undefined}
          aria-describedby={blockReason ? reasonId : undefined}
          onClick={submit}
        >
          <ArrowUp className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{blockReason ?? 'Send (Enter)'}</TooltipContent>
    </Tooltip>
  );

  const options = (
    <ComposerOptions
      variant={variant}
      context={context}
      model={engine.model}
      setModel={engine.setModel}
      streamMode={engine.streamMode}
      setStreamMode={engine.setStreamMode}
      canChooseModel={canChooseModel}
      models={catalog.models}
      modelsState={catalog.modelsState}
      loadModels={catalog.loadModels}
      prompts={prompts}
      draft={draft}
      onUsePrompt={insertPrompt}
      onSaveCurrent={() => setSaveText(draft)}
      onManagePrompts={() => setManageOpen(true)}
      onOpenShortcuts={onOpenShortcuts}
    />
  );

  const textarea = (
    <textarea
      id={inputId}
      ref={textareaRef}
      rows={1}
      value={draft}
      onChange={(event) => {
        engine.setDraft(event.target.value);
        syncCaret(event);
      }}
      onSelect={syncCaret}
      onKeyDown={onKeyDown}
      onFocus={() => {
        setFocused(true);
        onComposerFocus?.();
      }}
      onBlur={() => setFocused(false)}
      placeholder={blockReason ?? (isCase ? CASE_COMPOSER_PLACEHOLDER : narrow ? COMPOSER_PLACEHOLDER_NARROW : COMPOSER_PLACEHOLDER)}
      aria-describedby={blockReason ? `${hintId} ${reasonId}` : hintId}
      aria-autocomplete={isCase ? undefined : 'list'}
      aria-controls={menuOpen ? listId : undefined}
      aria-activedescendant={menuOpen ? activeId : undefined}
      className={cn(
        'block w-full resize-none bg-transparent text-sm leading-6 text-foreground outline-none',
        'placeholder:text-muted-foreground [field-sizing:content]',
        isCase ? 'max-h-40 min-h-8 px-2 py-1' : 'max-h-60 min-h-9 px-1.5 py-1.5',
      )}
    />
  );

  const srHelp = (
    <>
      <span id={hintId} className="sr-only">
        {isCase
          ? 'Enter sends. Shift+Enter adds a line.'
          : 'Enter sends. Shift+Enter adds a line. Type / for commands or @ to limit the scope.'}
      </span>
      {blockReason ? (
        <span id={reasonId} className="sr-only">
          {blockReason}
        </span>
      ) : null}
    </>
  );

  // Rendered in both variants so the handle's `savePrompt` always has a dialog.
  const dialogs = (
    <>
      <SavePromptDialog
        open={saveText !== null}
        onOpenChange={(open) => {
          if (!open) setSaveText(null);
        }}
        initialText={saveText ?? ''}
        controller={prompts}
        onCloseFocus={focusTextarea}
      />
      <ManagePromptsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        controller={prompts}
        onUse={insertPrompt}
        onCloseFocus={focusTextarea}
      />
    </>
  );

  if (isCase) {
    return (
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegated Esc-to-stop for the composer's own native controls
      <div ref={rootRef} className={cn('w-full', className)} onKeyDown={onRootKeyDown} data-chat-composer="case">
        <label className="sr-only" htmlFor={inputId}>
          Ask about this case
        </label>
        <div
          className={cn(
            'flex items-end gap-1 rounded-md border border-input bg-card p-1 transition-colors',
            'has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/30',
          )}
        >
          {textarea}
          <div className="flex h-8 shrink-0 items-center gap-0.5">
            {context ? <TokenMeter context={context} draft={draft} showRing={false} /> : null}
            {options}
            {sendStop}
          </div>
        </div>
        {srHelp}
        {dialogs}
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegated Esc-to-stop for the composer's own native controls
    <div ref={rootRef} className={cn('w-full', className)} onKeyDown={onRootKeyDown} data-chat-composer="workspace">
      <label className="sr-only" htmlFor={inputId}>
        Message the assistant
      </label>
      <Popover
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open) setDismissedDraft(draft);
        }}
      >
        <PopoverAnchor asChild>
          <div
            className={cn(
              'rounded-md border border-input bg-card px-2 pb-1.5 pt-1.5 transition-colors',
              // The field's focus shows on the frame; a focused chip keeps its own ring.
              'has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/30',
            )}
          >
            {textarea}
            <div className="mt-1 flex h-8 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Tooltip>
                  <AccessPopover
                    context={context}
                    error={contextError}
                    onRetry={onRetryContext}
                    open={accessOpen}
                    onOpenChange={setAccessOpen}
                  >
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(chipButton, narrow && 'w-7 justify-center px-0')}
                        aria-label="Read-only. What can the assistant access?"
                      >
                        <Lock aria-hidden="true" />
                        {narrow ? null : <span>Read-only</span>}
                      </button>
                    </TooltipTrigger>
                  </AccessPopover>
                  <TooltipContent className="max-w-xs">{READ_ONLY_TOOLTIP}</TooltipContent>
                </Tooltip>
                <ScopeControls
                  target={engine}
                  context={context}
                  sources={catalog.sources}
                  sourcesState={catalog.sourcesState}
                  merged={merged}
                  onDone={focusTextarea}
                />
                {engine.model ? (
                  // Narrow keeps an icon-only chip: a non-default (possibly pricier)
                  // model must stay visible and removable at every width.
                  <ModelChip
                    model={engine.model}
                    compact={narrow}
                    onClear={() => {
                      engine.setModel(null);
                      focusTextarea();
                    }}
                  />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {context ? (
                  <TokenMeter context={context} draft={draft} conversationTotals={conversationTotals} />
                ) : null}
                {options}
                {sendStop}
              </div>
            </div>
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          aria-label={menuKind === 'at' ? 'Scopes' : 'Commands'}
          className="w-[min(30rem,calc(100vw-2rem))] p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // Clicks and focus inside the composer keep the menu; it follows the draft.
            if (rootRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
          // Keep focus in the textarea when an item is clicked.
          onMouseDown={(event) => event.preventDefault()}
        >
          {menuKind ? (
            <ComposerMenu
              kind={menuKind}
              groups={groups}
              active={activeValue}
              onActiveChange={setActive}
              onChoose={choose}
              onListRendered={onListRendered}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      {srHelp}
      {dialogs}
    </div>
  );
});
