/**
 * Composer — the chat input (SPEC §10.4, §10.4a, §8 meter).
 *
 * INTERFACE STUB written by the orchestrator so the workspace shell (WP-I2a) and the
 * composer package (WP-I2b) can build in parallel. WP-I2b owns this file and replaces
 * the body; `ComposerProps` / `ComposerHandle` and the named export must stay
 * compatible (additive optional props are fine).
 */
import * as React from 'react';
import type { ChatContextInfo } from '@/lib/types';
import { Button } from '@/ui/button';
import type { ChatEngine } from '../useChatEngine';

export interface ComposerHandle {
  /** Move focus into the textarea (Shift+Esc, New chat, thread switch). */
  focus: () => void;
  /** Replace the draft and focus (e.g. "Save prompt" → edit, ↑ edit-last handled inside). */
  setText: (text: string) => void;
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
}

export const Composer = React.forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { engine, disabledReason, className },
  ref,
) {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  React.useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setText: (text: string) => {
      engine.setDraft(text);
      textareaRef.current?.focus();
    },
  }));
  const running = engine.busy;
  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        if (!running && !disabledReason) engine.send();
      }}
    >
      <label className="sr-only" htmlFor="chat-composer-input">
        Message
      </label>
      <textarea
        id="chat-composer-input"
        ref={textareaRef}
        value={engine.draft}
        onChange={(event) => engine.setDraft(event.target.value)}
        placeholder="Ask about your data or this app. / for commands, @ to scope"
      />
      {running ? (
        <Button type="button" onClick={() => engine.stop()} disabled={!engine.canStop}>
          Stop
        </Button>
      ) : (
        <Button type="submit" disabled={!!disabledReason || !engine.draft.trim()}>
          Send
        </Button>
      )}
    </form>
  );
});
