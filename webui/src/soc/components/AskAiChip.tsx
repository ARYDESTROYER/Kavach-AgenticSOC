/**
 * AskAiChip — "Ask AI" beside an entity value (Round 12 WP-ASK, SYNTHESIS-chat P1-5;
 * Palo Alto "Ask AI", Elastic "Add to chat", CrowdStrike's embedded one-click).
 *
 * A quiet button beside an IP, host, user, hash, domain, URL, email address, rule or
 * case id. It opens the Workspace chat on a NEW conversation with a TYPED REFERENCE to the
 * value (`NavOpts.entity`), never free text: the chat page resolves it to the server's
 * question (`POST /api/chat/entity-question`) and sends that with `origin: "starter"` —
 * the topic pattern of "Ask about this" (SPEC A7). The value is log- or case-derived, so
 * it is never analyst-authored for the indicator taint rule (#9): a third-party lookup of
 * it runs only when the policy allows it. Nothing is prefilled in the composer, so a held
 * Enter can never send words the analyst did not choose. From inside a case it still
 * opens the Workspace chat, never the case-scoped case chat (#5). The reference travels
 * in memory only (the router never writes `entity` to the URL).
 *
 * What it asks about: the `kind` a host names, else the kind the entity `type` names,
 * else a `type:value` key's prefix or the value's own shape; the value must have that
 * kind's shape (`ask-ai.ts`, the server's grammar). Otherwise the chip renders nothing.
 *
 * Two forms:
 *  - `reveal` (default): an icon-only 24 px button (the CopyId size) named "Ask AI about
 *    <value>", shown when the pointer is over, or focus is inside, its nearest `group/ask`
 *    ancestor (hosts put that class on the value's row) and whenever it has keyboard
 *    focus itself, so it is always reachable by Tab; touch screens (no hover) always show
 *    it. Icon-only so a hidden chip reserves one small square, not a label's width, in
 *    dense tables and header rows.
 *  - `reveal={false}`: an always-visible labelled "Ask AI" chip (an action row).
 * Either way it is `select-none`, so copying a row or a value never copies "Ask AI".
 *
 * Hidden entirely when the viewer cannot use chat (`cases:read`, the chat routes'
 * permission) and outside the app router or auth (standalone renders, tests, embeds):
 * the host passes the router's `navigate` and the viewer's `hasPermission`, and the
 * chip renders nothing without them.
 *
 * Loading: hosts load this module ON DEMAND (a dynamic `import()` started when the host
 * module loads; the host renders the chip once it has arrived, and nothing if it cannot
 * load) and import nothing else from it at runtime. A statically shared module would
 * become a chunk every host route's preload list names, and those lists live in the
 * entry chunk, which sits at its size ceiling. Hosts write the `group/ask` class
 * literally for the same reason. The host reads the router and auth contexts and passes
 * them in, so this module imports neither: the test setup loads it up front (a host then
 * renders it synchronously under test, as in the app once the chunk is cached) without
 * fixing which auth or router module a test sees.
 *
 * SECURITY (#9): the value is untrusted log or case data. It is rendered by the host as a
 * plain text node, appears here only inside the accessible name and tooltip (attributes,
 * never markup), and reaches the server as a typed field, never as a message.
 */
import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import type { Navigate } from '@/soc/router';

import { askAiLabel, resolveAskTarget, type AskEntityKind } from './ask-ai';

/** The class a host puts on the row whose hover or focus reveals its chip. */
export const ASK_AI_ROW = 'group/ask';

/** Revealed with its row (the KPI help-trigger recipe); always shown without hover. */
const REVEAL =
  'opacity-0 transition-opacity duration-fast group-hover/ask:opacity-100 group-focus-within/ask:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none';

/** The hover-revealed form: a 24 px icon button, the size of the copy buttons beside it. */
const ICON =
  'size-6 justify-center rounded-md text-primary hover:bg-primary/10 [&_svg]:size-3.5';

/** The always-visible form: a labelled chip in the shape of the Copy chip beside it. */
const LABELLED =
  'gap-1 rounded-md border border-border bg-card px-2 py-1 text-2xs font-medium leading-normal text-primary transition-colors hover:border-primary/40 hover:bg-primary/10 [&_svg]:size-3';

export interface AskAiChipProps {
  /** What the value is (decides the question); else read from `type`/`value`. */
  kind?: AskEntityKind;
  /** The entity-type token the host shows (`ip`, `file_hash`, `hostname`…), if any. */
  type?: string | null;
  /** The value itself (untrusted; the chip renders nothing when it has no reference). */
  value: string | null | undefined;
  /** Reveal an icon with the `group/ask` row (default) or show a labelled chip (`false`). */
  reveal?: boolean;
  className?: string;
}

/** What the host reads from the app shell and passes in (absent: no chip). */
export interface AskAiChipAccess {
  /** The app router's navigate (`useRoute().navigate`). */
  navigate?: Navigate | null;
  /** The viewer's permission check (`useAuth().hasPermission`). */
  hasPermission?: ((resource: string, action: string) => boolean) | null;
}

export function AskAiChip({
  kind,
  type,
  value,
  reveal = true,
  className,
  navigate,
  hasPermission,
}: AskAiChipProps & AskAiChipAccess) {
  const target = resolveAskTarget({ kind, type, value });
  if (!target || typeof navigate !== 'function') return null;
  if (typeof hasPermission !== 'function' || !hasPermission('cases', 'read')) return null;
  const label = askAiLabel(target.kind, target.value);
  return (
    <button
      type="button"
      onClick={(event) => {
        // A row or card that opens on click must not open too.
        event.stopPropagation();
        navigate('chat', { newChat: true, entity: { kind: target.kind, value: target.value } });
      }}
      onKeyDown={(event) => {
        // Enter / Space belong to this button, never to a row shortcut handler.
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      aria-label={label}
      // The icon form's only visible name; the labelled chip says "Ask AI" itself.
      title={reveal ? label : undefined}
      data-ask-ai={target.kind}
      className={cn(
        'inline-flex shrink-0 select-none items-center whitespace-nowrap font-sans normal-case tracking-normal print:hidden',
        '[&_svg]:shrink-0',
        reveal ? ICON : LABELLED,
        focusRing,
        reveal && REVEAL,
        className,
      )}
    >
      <Sparkles aria-hidden />
      {reveal ? null : 'Ask AI'}
    </button>
  );
}

export default AskAiChip;
