/**
 * Composer — the chat input (SPEC §10.4, §10.4a, §8 meter).
 *
 * Workspace variant: a textarea plus ONE 32 px control row (≤ 88 px at rest):
 *   left  — Read-only lock chip (tooltip + access popover), Scope chip ("<source> ·
 *           24h"), removable @-scope chips, the removable non-default model chip;
 *   right — "≈ 1.2k" estimate + context-window ring (hover card: the next request,
 *           the context window and, for a `models:read` viewer, today's AI budget),
 *           Options ⋯, Send ↔ Stop.
 * Below 560 px of composer width the Scope and @ chips merge into "Scope · n" and the
 * lock chip keeps only its icon. The compact Case Manager variant is the textarea,
 * the estimate, Options (Model, Type out answers) and Send/Stop on one line.
 *
 * Keyboard: Enter sends, Shift+Enter adds a line, nothing fires while an input method
 * composes (isComposing / keyCode 229). While a turn runs the textarea stays editable,
 * Enter does nothing and Send becomes Stop; Esc stops the turn only when focus is in
 * the composer and no menu, popover, sheet or dialog is open (a Radix layer closing on
 * Esc marks the event handled first). ↑ in an empty composer brings back the last
 * prompt. `/` at the start opens commands, the analyst's prompts, starter prompts and
 * the prompt library; `@` opens the scopes.
 *
 * Prompt library (Round 12 SPEC §3.1): a prompt with `{placeholders}` or a promptbook
 * opens an inline card above the field that asks for the values before anything is
 * sent; a promptbook then runs its steps as consecutive turns with a step counter and
 * Stop (Send is paused while it runs; the book outlives this component, so leaving the
 * chat page and coming back carries on). The card waits, and says why, while an answer
 * is being written or sending is blocked. A prompt with nothing to ask goes straight
 * into the field, as before; chosen from Options ⋯ it takes focus there (or into its
 * card) instead of back to ⋯.
 * In those menus only Enter chooses: Tab keeps its focus-navigation meaning, so it can
 * never send a command turn or add a scope by accident. The case variant has no menus
 * and its placeholder does not mention them.
 *
 * Drafts live in the engine (per thread, owned by the host). The composer never
 * stores message text anywhere else.
 *
 * Round 13 (SPEC-chat T13, §7.1):
 * - The placeholder is a plain question prompt ("Ask about cases, logs, metrics or this
 *   console"; "Ask a question" below 560 px). The key hints moved to a muted
 *   "/ commands · @ scope" at the right of the control row, shown only while the field
 *   is focused and empty (and not below 560 px, where the row has no room for it).
 * - The focus frame is quieter than Round 12's 2 px glow at 30 %: the 1 px `border-ring`
 *   plus a solid 1 px outer `ring-1 ring-ring` ({@link COMPOSER_FOCUS_FRAME}). The SPEC's
 *   `ring-2 ring-ring/15` measured 1.23:1 and the border change alone 1.49:1 (light),
 *   under its own 3:1 rule; the solid outer pixel changes from the page to the ring
 *   colour at 4.7:1 (light) and 8:1 (dark).
 * - The meter keeps its slot but is invisible at rest (TokenMeter).
 * - The Workspace composer listens to the two prompt-library events
 *   (`composer/library-events.ts`): `openPromptLibrary({categories})` opens the library
 *   filtered to a start-screen pill's categories, and `pickPromptFromLibrary(id)` runs
 *   one saved or ready-made prompt through exactly the library's Use path (fill the
 *   field, open its values card, or start the promptbook). An id that cannot be found
 *   says so in a toast and changes nothing; a saved-prompt read that failed says that
 *   instead (the prompt may well exist). A library a pill opened and that closes with
 *   nothing chosen hands focus back to the pill.
 */
import * as React from 'react';
import { ArrowUp, Lock, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatContextInfo, ChatPrompt, ChatPromptCategory } from '@/lib/types';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { useAnnouncer } from '@/soc/components/announcer';
import { getSavedPrompts } from '../chat-api';
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
import { SCOPE_LABELS, withClientHistory } from './format';
import { onOpenPromptLibrary, onPickPromptFromLibrary } from './library-events';
import { PromptLibraryDialog } from './PromptLibrary';
import { planIsDirect, planPrompt, visibleStarters, type LibraryPrompt, type PromptPlan } from './prompt-library';
import { PROMPTBOOK_RUNNING_REASON, PromptParamsCard, PromptbookBar, usePromptbookRunner } from './PromptRunner';
import { SavePromptDialog, useSavedPrompts, type PromptDraft } from './SavedPrompts';
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
  /**
   * The configured default model (`useChatContext().defaultModel`). Choosing it is the
   * same as "Default model", so it never shows as a removable non-default chip and is
   * never sent as an explicit override.
   */
  defaultModel?: string | null;
}

/** The placeholder (SPEC-chat T13; was SPEC §10.4's key-hint list). */
export const COMPOSER_PLACEHOLDER = 'Ask about cases, logs, metrics or this console';
/**
 * Short enough for one line in a narrow composer. Chromium sizes a `field-sizing:
 * content` field from its placeholder, so the long one would wrap to two lines below
 * about 450 px and break the 88 px resting height (SPEC §10.4).
 */
export const COMPOSER_PLACEHOLDER_NARROW = 'Ask a question';
/** The muted key hint at the right of the control row while the field is focused and empty (T13). */
export const COMPOSER_KEY_HINT = '/ commands · @ scope';
/** A `use_prompt` starter (or any pick) named a prompt this viewer no longer has. */
export const PROMPT_UNAVAILABLE = 'That saved prompt is no longer available.';
/**
 * A pick of a saved prompt when the saved prompts could not be read: the prompt may well
 * exist, so this never says it is gone (that needs a read that succeeded without it).
 */
export const PROMPT_READ_FAILED = 'Saved prompts could not be loaded. Try again.';
/** The compact Case Manager composer has no `/` or `@` menus, so it never advertises them. */
export const CASE_COMPOSER_PLACEHOLDER = 'Ask about this case';
/** The Read-only chip's tooltip (SPEC §10.4, exact). */
export const READ_ONLY_TOOLTIP =
  'Searches logs, cases, metrics, intel and the help docs. It cannot change anything. Answers can be wrong; log content is untrusted data.';
/**
 * The field's focus on the composer frame (SPEC-chat T13): the 1 px border turns ring
 * colour and a solid 1 px ring draws outside it. Every pixel that changes keeps at least
 * 3:1 against what it was (measured in Composer.test), unlike a translucent glow.
 */
export const COMPOSER_FOCUS_FRAME =
  'has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-ring';
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
    defaultModel = null,
  } = props;
  const isCase = variant === 'case';
  const announce = useAnnouncer();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const width = useElementWidth(rootRef);
  const catalog = useComposerCatalog({ loadSources: !isCase, canReadSources: sourcesReadable(context) });
  // An engine that does not persist (case chat) sends its own history, which the
  // server's context figure cannot include: the meter counts it from the engine.
  const ownsHistory = !engine.persist;
  const historySize = engine.historySize;
  const meterContext = React.useMemo(
    () => (context && ownsHistory ? withClientHistory(context, historySize) : context),
    [context, ownsHistory, historySize],
  );
  // Only a model the analyst chose that differs from the configured default is an
  // override: the default never shows as a removable chip (D2).
  const chosenModel = engine.model && engine.model !== defaultModel ? engine.model : null;
  const { setModel: setEngineModel } = engine;
  const setModel = React.useCallback(
    (next: string | null) => setEngineModel(next && next !== defaultModel ? next : null),
    [defaultModel, setEngineModel],
  );
  const prompts = useSavedPrompts();
  const loadPrompts = prompts.load;
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
  const [saveDraft, setSaveDraft] = React.useState<PromptDraft | null>(null);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  /** A start-screen pill's library categories (Round 13); none = the whole library. */
  const [libraryCategories, setLibraryCategories] = React.useState<ChatPromptCategory[] | undefined>(undefined);
  /** A prompt id from `pickPromptFromLibrary`, until it is found (or not). */
  const [pendingPick, setPendingPick] = React.useState<string | null>(null);
  /** Focus the values card once a picked prompt has opened it. */
  const cardFocusPending = React.useRef(false);
  const [plan, setPlan] = React.useState<PromptPlan | null>(null);
  const pendingSelection = React.useRef<[number, number] | null>(null);
  /** Where focus goes when Options ⋯ closes after choosing a prompt (Radix would return it to ⋯). */
  const optionsCloseFocus = React.useRef<'card' | 'composer' | null>(null);
  // Promptbooks are Workspace-only; the book waits while the host restores a thread.
  const book = usePromptbookRunner(engine, announce, { enabled: !isCase, hostBlocked: Boolean(disabledReason) });

  const draft = engine.draft;
  const running = engine.busy;
  // Only the host (or a running promptbook) blocks Send. A spent AI budget never does:
  // it limits automatic investigations, not chat (SPEC D5).
  const blockReason = disabledReason || (book.running ? PROMPTBOOK_RUNNING_REASON : null);
  const canSend = !running && !blockReason && draft.trim().length > 0;
  const canChooseModel =
    props.canChooseModel ?? Boolean(context && (context.rates || context.budget || context.simulated !== null));
  const narrow = width !== null && width < COMPOSER_NARROW_PX;
  const merged = narrow || engine.scopes.length > MAX_INLINE_SCOPE_CHIPS;
  // The "/ commands · @ scope" hint: Workspace only, while the field is focused and empty.
  const showKeyHint = !isCase && !narrow && focused && draft === '' && !blockReason;

  // The width is an input so the JS fallback re-measures when the lane reflows
  // (rail toggled, report split opened) and not only on the next keystroke.
  useAutoGrow(textareaRef, draft, { maxHeight: MAX_TEXTAREA_PX, width });

  /* ---------------------------------------------------------------- menus -- */
  const slash = isCase ? null : parseSlashQuery(draft);
  // Without a catalogue every scope would read as denied: the @ menu waits for it.
  const at = isCase || slash || !context ? null : parseAtQuery(draft, caret);
  // `/compact` folds a SAVED conversation's history: a new chat has nothing to fold.
  const canCompact = engine.persist && Boolean(engine.conversationId);
  const groups = React.useMemo(() => {
    if (slash) return slashMenuGroups(slash, context, prompts.prompts, { canCompact });
    if (at) return atMenuGroups(at, context, engine.scopes);
    return [];
    // `slash`/`at` are re-derived from draft/caret each render; key on their inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, caret, context, prompts.prompts, engine.scopes, isCase, canCompact]);
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
  // A closed menu forgets its highlight: the next one opens on its first row, not on the
  // row chosen last time (which the menu would scroll to, T22).
  React.useEffect(() => {
    if (!menuOpen) setActive('');
  }, [menuOpen]);

  // Load saved prompts the first time `/` is typed (never at mount).
  const slashActive = Boolean(slash);
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
      savePrompt: (text: string) => setSaveDraft({ text }),
    }),
    [focusTextarea, replaceDraft],
  );

  /**
   * The control outside the composer that opened the library (a start-screen pill): a
   * library closed without choosing anything hands focus back to it, so a keyboard user
   * browsing the pills keeps their place. Null when the composer itself opened it.
   */
  const libraryOpener = React.useRef<HTMLElement | null>(null);
  /** A prompt was used (or a copy started) from the library: focus goes forward, not back. */
  const libraryChosen = React.useRef(false);

  /** Open the prompt library: the whole of it, or a start-screen pill's categories. */
  const openLibrary = React.useCallback(
    (categories?: readonly ChatPromptCategory[], opener: HTMLElement | null = null) => {
      loadPrompts();
      libraryOpener.current = opener;
      libraryChosen.current = false;
      setLibraryCategories(categories && categories.length ? [...categories] : undefined);
      setLibraryOpen(true);
    },
    [loadPrompts],
  );

  // The start screen's category pills (Workspace only, SPEC-chat §5.2).
  React.useEffect(() => {
    if (isCase) return undefined;
    return onOpenPromptLibrary(({ categories }) => {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const opener =
        active instanceof HTMLElement && active !== document.body && !rootRef.current?.contains(active) ? active : null;
      openLibrary(categories, opener);
    });
  }, [isCase, openLibrary]);

  // A `use_prompt` starter card (SPEC-chat §3.9): resolved below, then the Use path.
  React.useEffect(() => {
    if (isCase) return undefined;
    return onPickPromptFromLibrary(({ promptId }) => {
      loadPrompts();
      setPendingPick(promptId);
    });
  }, [isCase, loadPrompts]);

  /* -------------------------------------------------------------- actions -- */
  const submit = () => {
    if (!canSend) return;
    engine.send();
    focusTextarea();
  };

  /**
   * Use a library prompt: one with nothing to ask goes into the field; one with values
   * to fill, or a promptbook, opens the values card (the `/` query it came from is
   * cleared).
   */
  const pickPrompt = (prompt: LibraryPrompt, fromSlash = false): 'card' | 'composer' => {
    const next = planPrompt(prompt);
    if (planIsDirect(next)) {
      replaceDraft(prompt.text);
      return 'composer';
    }
    if (fromSlash) engine.setDraft('');
    setPlan(next);
    return 'card';
  };

  /** Focus the values card's first value (or Run), else the composer. */
  const focusCard = React.useCallback(() => {
    const card = rootRef.current?.querySelector<HTMLElement>(
      '[data-testid="prompt-params"] input, [data-testid="prompt-params"] button[type="submit"]',
    );
    if (card) card.focus();
    else focusTextarea();
  }, [focusTextarea]);

  // A picked prompt that opened its values card hands focus to it once it renders.
  React.useEffect(() => {
    if (!plan || !cardFocusPending.current) return;
    cardFocusPending.current = false;
    focusCard();
  }, [plan, focusCard]);

  /** Run a picked prompt exactly as the library's Use does (fill, values card or book). */
  const runPicked = React.useRef<(prompt: LibraryPrompt) => void>(() => undefined);
  runPicked.current = (prompt: LibraryPrompt) => {
    if (pickPrompt(prompt) === 'card') cardFocusPending.current = true;
  };

  // Resolve a picked id among the ready-made prompts this viewer can run and their saved
  // prompts (read first; a saved list read earlier is checked again before "not found").
  const savedState = prompts.state;
  const savedList = prompts.prompts;
  React.useEffect(() => {
    if (!pendingPick) return undefined;
    const id = pendingPick;
    if (id.startsWith('starter:')) {
      if (!context && !contextError) return undefined; // the catalogue decides what may run
      const starter = visibleStarters(context).find((prompt) => prompt.id === id);
      setPendingPick(null);
      if (starter) runPicked.current(starter);
      else toast(PROMPT_UNAVAILABLE);
      return undefined;
    }
    if (savedState === 'idle' || savedState === 'loading') return undefined;
    const known = savedList.find((prompt) => prompt.id === id);
    if (known) {
      setPendingPick(null);
      runPicked.current(known);
      return undefined;
    }
    // Not in the list this composer holds: read the saved prompts once more (another tab
    // may have saved it since), then use it or say it is gone. Only a read that
    // succeeded without it means "gone": a failed read (this one, after the list itself
    // failed to load) says so and changes nothing.
    let alive = true;
    void getSavedPrompts()
      .then(
        (fresh): LibraryPrompt | 'missing' => fresh.find((prompt) => prompt.id === id) ?? 'missing',
        (): 'failed' => 'failed',
      )
      .then((found) => {
        if (!alive) return;
        setPendingPick(null);
        if (found === 'failed') toast.error(PROMPT_READ_FAILED);
        else if (found === 'missing') toast(PROMPT_UNAVAILABLE);
        else runPicked.current(found);
      });
    return () => {
      alive = false;
    };
  }, [pendingPick, savedState, savedList, context, contextError]);

  /** The values card was submitted with the filled steps (only while sending is possible). */
  const runPlan = (current: PromptPlan, steps: string[]) => {
    if (current.book) {
      if (book.start(current.prompt.title, steps)) {
        setPlan(null);
        focusTextarea();
      }
      return;
    }
    const text = steps[0];
    setPlan(null);
    if (engine.send(text, { origin: 'user' })) {
      focusTextarea();
      return;
    }
    // The engine refused it after all: keep the filled prompt in the field.
    replaceDraft(text);
    announce('Added to the composer.');
  };

  const choose = (item: ComposerMenuItem) => {
    if (item.kind === 'prompt') {
      pickPrompt(item.prompt, true);
      return;
    }
    if (item.kind === 'library') {
      engine.setDraft('');
      openLibrary();
      return;
    }
    if (item.kind === 'scope') {
      if (item.disabled || !at) return;
      const next = removeAtToken(draft, at);
      engine.setScopes([...engine.scopes, item.access.scope]);
      replaceDraft(next.text, [next.caret, next.caret]);
      announce(`Limited to ${SCOPE_LABELS[item.access.scope]}`);
      return;
    }
    const action = slashAction(item);
    if (!action || action.type === 'library') return;
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
      // A held key's auto-repeat never sends: the press that brought focus here (the
      // palette's "Ask AI" hand-off prefills and focuses this field) may still be down.
      if (event.repeat) return;
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
      model={chosenModel}
      setModel={setModel}
      defaultModel={defaultModel}
      streamMode={engine.streamMode}
      setStreamMode={engine.setStreamMode}
      canChooseModel={canChooseModel}
      models={catalog.models}
      modelsState={catalog.modelsState}
      loadModels={catalog.loadModels}
      prompts={prompts}
      draft={draft}
      onUsePrompt={(prompt: ChatPrompt) => {
        optionsCloseFocus.current = pickPrompt(prompt);
      }}
      onSaveCurrent={() => setSaveDraft({ text: draft })}
      onOpenLibrary={() => openLibrary()}
      onOpenShortcuts={onOpenShortcuts}
      onCloseAutoFocus={(event) => {
        // A chosen prompt hands focus to its values card (or the field it filled);
        // anything else returns it to ⋯ as usual.
        const target = optionsCloseFocus.current;
        optionsCloseFocus.current = null;
        if (!target) return;
        event.preventDefault();
        if (target === 'card') focusCard();
        else focusTextarea();
      }}
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
        open={saveDraft !== null}
        onOpenChange={(open) => {
          if (!open) setSaveDraft(null);
        }}
        initialText={saveDraft?.text ?? ''}
        initial={saveDraft}
        controller={prompts}
        onCloseFocus={focusTextarea}
      />
      {isCase ? null : (
        <PromptLibraryDialog
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          controller={prompts}
          context={context}
          contextError={contextError}
          onUse={(prompt) => {
            libraryChosen.current = true;
            void pickPrompt(prompt);
          }}
          onCompose={(next) => {
            libraryChosen.current = true;
            setSaveDraft(next);
          }}
          categories={libraryCategories}
          // A chosen prompt with values moves focus into its card (its first value, or
          // Run for a promptbook without values); otherwise back to the field. Closed
          // without a choice after a start-screen pill opened it: back to that pill.
          onCloseFocus={() => {
            const opener = libraryOpener.current;
            const chosen = libraryChosen.current;
            libraryOpener.current = null;
            libraryChosen.current = false;
            if (!chosen && opener?.isConnected) opener.focus();
            else focusCard();
          }}
        />
      )}
    </>
  );

  // The values card (a prompt with placeholders, or a promptbook) and the promptbook's
  // step counter sit above the field.
  const promptCards = isCase ? null : (
    <>
      <PromptbookBar runner={book} onClosed={focusTextarea} />
      {plan ? (
        <PromptParamsCard
          key={plan.prompt.id}
          plan={plan}
          // A prompt and a promptbook alike wait for the current answer, a running
          // promptbook or whatever else blocks sending, and say which. The longer-lived
          // reason wins: a running book keeps the engine busy step after step, so
          // "wait for the current answer" would be wrong until the whole book ends.
          canRun={!running && !blockReason}
          blockedReason={blockReason ?? (running ? 'Wait for the current answer to finish.' : null)}
          onSubmit={(steps) => runPlan(plan, steps)}
          onCancel={() => {
            setPlan(null);
            focusTextarea();
          }}
        />
      ) : null}
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
            COMPOSER_FOCUS_FRAME,
          )}
        >
          {textarea}
          <div className="flex h-8 shrink-0 items-center gap-0.5">
            {meterContext ? <TokenMeter context={meterContext} draft={draft} showRing={false} /> : null}
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
      {promptCards}
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
              COMPOSER_FOCUS_FRAME,
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
                {chosenModel ? (
                  // Narrow keeps an icon-only chip: a non-default (possibly pricier)
                  // model must stay visible and removable at every width.
                  <ModelChip
                    model={chosenModel}
                    compact={narrow}
                    onClear={() => {
                      engine.setModel(null);
                      focusTextarea();
                    }}
                  />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {meterContext ? (
                  <TokenMeter
                    context={meterContext}
                    draft={draft}
                    conversationTotals={conversationTotals}
                    compact={narrow}
                  />
                ) : null}
                {/* Beside Options: the meter's resting slot (invisible while the field is
                    empty) sits to its left, so the hint never floats away from the controls. */}
                {showKeyHint ? (
                  <span className="whitespace-nowrap px-1 text-xs text-muted-foreground" aria-hidden="true" data-testid="composer-key-hint">
                    {COMPOSER_KEY_HINT}
                  </span>
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
          // A 16 px gutter from the screen edge on a phone (as the scope popover, T23).
          collisionPadding={16}
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
