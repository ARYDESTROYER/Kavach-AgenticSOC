/**
 * CaseThread — full collaboration thread for a case (#4).
 *
 * A threaded discussion where the AI is a FIRST-CLASS author beside humans and the
 * system. Backed by `GET/POST /api/cases/{id}/thread`, `PATCH/DELETE` a message, and
 * `POST .../reactions`. Persisted in-case AI chat turns surface in the SAME thread.
 *
 * Features:
 *   - distinct human / ai / system author styling (avatar colour + a "AI" / "system"
 *     label badge);
 *   - one-level replies (reply composer nested under a root message);
 *   - @mention autocomplete resolved against the user list;
 *   - in-place edit + soft-delete (a tombstoned message renders a placeholder so
 *     replies keep their parent);
 *   - emoji reactions (toggle a small fixed set).
 *
 * SECURITY (#9): EVERY message `body`, `mentions` token, `author`, and reaction
 * `emoji` is operator-/AI-authored UNTRUSTED text. It is rendered EXCLUSIVELY as
 * plain text nodes (whitespace-preserved) — never markup, never an href/src. The
 * @mention HIGHLIGHTER tokenises the plain string and wraps matched tokens in a
 * <span>; it never parses HTML. Writes are gated by the caller with <Can> (the
 * composer is only mounted when `canComment`).
 *
 * LIVE (Wave 4): optionally subscribes to the per-case SSE room (`cases:{liveCaseId}`)
 * via `useEventStream`. A `case.activity` frame nudges the caller (`onLiveActivity`) to
 * refetch the authoritative thread so a teammate's/AI's new message appears without a
 * manual refresh. Purely additive: with no `liveCaseId` (default) the thread is the
 * same pure presentational surface and the parent keeps polling. The frame payload is
 * never rendered (#9) — it only triggers a reload.
 */
import * as React from 'react';

import { useEventStream } from '@/lib/useEventStream';
import {
  Bot,
  Check,
  CornerDownRight,
  Pencil,
  Reply,
  SmilePlus,
  Trash2,
  User as UserIcon,
  X,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, humanizeAge } from '@/lib/format';

import { Avatar, AvatarFallback } from '@/ui/avatar';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { EmptyState } from '@/soc/components/EmptyState';
import { Markdown } from '@/soc/components/Markdown';

import type { CaseMessage, PickableUser } from '@/soc/pages/CaseDetail.api';

/* ------------------------------------------------------------- mention text */

const MENTION_RE = /(?<![\w@])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;

/**
 * Render an UNTRUSTED message body as React text nodes, wrapping @mention tokens in a
 * highlighted (but non-interactive, non-markup) <span>. Splits the plain string on a
 * regex — it NEVER interprets the body as HTML, so no markup can escape (#9).
 */
function renderBody(body: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(
      <span
        key={`${m.index}-${m[1]}`}
        className="rounded bg-primary/10 px-1 font-medium text-primary"
      >
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out.length ? out : [body];
}

/* ----------------------------------------------------------- author styling */

type AuthorKind = 'human' | 'ai' | 'system';

function authorKind(t: string | undefined): AuthorKind {
  const v = (t || '').toLowerCase();
  if (v === 'ai') return 'ai';
  if (v === 'system') return 'system';
  return 'human';
}

function initials(name: string): string {
  const n = (name || '').trim();
  if (!n) return 'A';
  return (
    n
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || '')
      .join('') || n[0]?.toUpperCase() || 'A'
  );
}

const AUTHOR_AVATAR: Record<AuthorKind, string> = {
  ai: 'bg-info/15 text-info',
  system: 'bg-muted text-muted-foreground',
  human: 'bg-primary/10 text-primary',
};

/* --------------------------------------------------------- mention popover -- */

/** A tiny anchored autocomplete listing username matches for the active @token. */
const MentionMenu: React.FC<{
  matches: PickableUser[];
  active: number;
  onPick: (u: PickableUser) => void;
}> = ({ matches, active, onPick }) => {
  if (!matches.length) return null;
  return (
    <div className="absolute bottom-full left-0 z-20 mb-1 max-h-48 w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
      {matches.map((u, i) => (
        <button
          key={u.username}
          type="button"
          // Mouse-down so the textarea doesn't blur before the pick fires.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(u);
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
            i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          )}
        >
          {/* UNTRUSTED username — plain text. */}
          <span className="truncate font-medium">{u.username}</span>
          {u.role ? (
            <span className="ml-auto truncate text-xs text-muted-foreground">{u.role}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------- composer ----- */

/** A textarea with @mention autocomplete. Controlled `value`; emits `onSubmit(text)`. */
const ThreadComposer: React.FC<{
  users: PickableUser[];
  placeholder?: string;
  submitLabel?: string;
  busy?: boolean;
  autoFocus?: boolean;
  /** Seed text (for editing an existing message). Applied on mount; the edit branch
   *  mounts a fresh composer each time so the seed re-applies per edit session. */
  initialValue?: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}> = ({ users, placeholder, submitLabel = 'Post', busy, autoFocus, initialValue, onSubmit, onCancel }) => {
  const [text, setText] = React.useState(initialValue ?? '');
  const [menuActive, setMenuActive] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  // The active @token immediately before the caret (if any).
  const token = React.useMemo(() => {
    const el = ref.current;
    const caret = el ? el.selectionStart ?? text.length : text.length;
    const upto = text.slice(0, caret);
    const m = /(?:^|[^\w@])@([A-Za-z0-9._-]*)$/.exec(upto);
    return m ? { query: m[1], start: caret - m[1].length } : null;
  }, [text]);

  const matches = React.useMemo(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    return users
      .filter((u) => u.username.toLowerCase().includes(q))
      .slice(0, 6);
  }, [token, users]);

  // Reset the active row AND the Escape-dismissal whenever the active @token changes
  // (i.e. the next keystroke re-opens the menu after an Escape).
  React.useEffect(() => {
    setMenuActive(0);
    setDismissed(false);
  }, [token?.query]);

  // The menu is open when there are matches AND the user hasn't Escaped it.
  const menuOpen = matches.length > 0 && !dismissed;

  const pick = (u: PickableUser) => {
    const el = ref.current;
    const caret = el ? el.selectionStart ?? text.length : text.length;
    const before = text.slice(0, token ? token.start : caret);
    const after = text.slice(caret);
    const next = `${before}${u.username} ${after}`;
    setText(next);
    // Restore focus + caret after the inserted mention.
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = before.length + u.username.length + 1;
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText('');
  };

  return (
    <div className="relative">
      {menuOpen ? (
        <MentionMenu matches={matches} active={menuActive} onPick={pick} />
      ) : null}
      <Textarea
        ref={ref}
        rows={onCancel ? 2 : 3}
        /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement in a comment composer/dialog; behavior-preserving */
        autoFocus={autoFocus}
        className="resize-none"
        placeholder={placeholder || 'Add a comment… use @ to mention a teammate'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setMenuActive((a) => Math.min(a + 1, matches.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setMenuActive((a) => Math.max(a - 1, 0));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              const sel = matches[menuActive];
              if (sel) {
                e.preventDefault();
                pick(sel);
                return;
              }
            }
            if (e.key === 'Escape') {
              // Actually dismiss the menu (visibility keys off `dismissed`, not the
              // trailing token) and swallow the key so it doesn't also close a parent
              // surface. The next keystroke re-opens it (the token effect clears it).
              e.preventDefault();
              setDismissed(true);
              setMenuActive(0);
              return;
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        ) : null}
        <Button size="sm" onClick={submit} disabled={busy || !text.trim()}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
};

/* ----------------------------------------------------------- reaction bar -- */

const QUICK_EMOJI = ['👍', '🎯', '👀', '✅', '🔥'];

/** Collapse a reaction list into `{emoji → users[]}` (defensive on shape). */
function reactionCounts(
  reactions: CaseMessage['reactions'],
): Array<{ emoji: string; users: string[] }> {
  const map = new Map<string, string[]>();
  for (const r of reactions || []) {
    const emoji = typeof r?.emoji === 'string' ? r.emoji : '';
    if (!emoji) continue;
    const user = typeof r?.user === 'string' ? r.user : '';
    const list = map.get(emoji) || [];
    list.push(user);
    map.set(emoji, list);
  }
  return Array.from(map.entries()).map(([emoji, users]) => ({ emoji, users }));
}

/* --------------------------------------------------------------- message ---- */

interface MessageItemProps {
  msg: CaseMessage;
  replies: CaseMessage[];
  users: PickableUser[];
  currentUser: string | null;
  canComment: boolean;
  busyId: string | null;
  onReply: (parentId: string, text: string) => void;
  onEdit: (msgId: string, text: string) => void;
  onDelete: (msgId: string) => void;
  onReact: (msgId: string, emoji: string, remove: boolean) => void;
  /** When true this is a nested reply (no further reply control). */
  nested?: boolean;
}

const MessageItem: React.FC<MessageItemProps> = ({
  msg,
  replies,
  users,
  currentUser,
  canComment,
  busyId,
  onReply,
  onEdit,
  onDelete,
  onReact,
  nested,
}) => {
  const [editing, setEditing] = React.useState(false);
  const [replyingTo, setReplyingTo] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const kind = authorKind(msg.author_type);
  const deleted = Boolean(msg.deleted || msg.deleted_at);
  const name = (msg.author || '').trim() || (kind === 'ai' ? 'Assistant' : kind === 'system' ? 'System' : 'Analyst');
  const mine =
    !!currentUser && (msg.author || '').toLowerCase() === currentUser.toLowerCase() && kind === 'human';
  const busy = busyId === msg.id;
  const counts = reactionCounts(msg.reactions);

  return (
    <div className={cn('flex items-start gap-3', nested && 'mt-3')} data-author-type={msg.author_type}>
      <Avatar className={cn('h-8 w-8', nested && 'h-7 w-7')}>
        <AvatarFallback className={AUTHOR_AVATAR[kind]}>
          {kind === 'ai' ? <Bot className="h-4 w-4" /> : initials(name)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'rounded-lg border p-3',
            kind === 'ai'
              ? 'border-info/30 bg-info/5'
              : kind === 'system'
                ? 'border-dashed border-border bg-muted/30'
                : 'border-border bg-card',
          )}
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* UNTRUSTED author — plain text. */}
            <span className="truncate text-sm font-semibold text-foreground">{name}</span>
            {kind === 'ai' ? (
              <Badge variant="info" className="gap-1 px-1.5 py-0">
                <Bot className="h-3 w-3" /> AI
              </Badge>
            ) : kind === 'system' ? (
              <Badge variant="secondary" className="px-1.5 py-0">
                system
              </Badge>
            ) : null}
            {msg.kind && msg.kind !== 'comment' ? (
              <Badge variant="outline" className="px-1.5 py-0 text-2xs">
                {msg.kind}
              </Badge>
            ) : null}
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {msg.created_at ? humanizeAge(msg.created_at) : DASH}
              {msg.edited_at ? ' · edited' : ''}
            </span>
          </div>

          {deleted ? (
            <p className="mt-1 text-sm italic text-muted-foreground">This message was deleted.</p>
          ) : editing ? (
            <div className="mt-2">
              <ThreadComposer
                users={users}
                /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                autoFocus
                submitLabel="Save"
                busy={busy}
                initialValue={msg.body || ''}
                placeholder="Edit your message…"
                onCancel={() => setEditing(false)}
                onSubmit={(text) => {
                  onEdit(msg.id, text);
                  setEditing(false);
                }}
              />
            </div>
          ) : (
            <>
              {kind === 'ai' ? (
                /* AI-authored body: the dependency-free safe Markdown renderer (React nodes
                   only, never an HTML string — #9), so `**bold**` and `code` read as
                   formatting instead of raw asterisks and backticks (CM-8). */
                <div className="mt-1 break-words text-sm text-foreground/90" data-testid="case-thread-ai-body">
                  <Markdown text={msg.body || ''} className="space-y-1.5 text-sm leading-relaxed" />
                </div>
              ) : (
                /* UNTRUSTED human body — plain text with non-markup @mention highlight (#9). */
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
                  {renderBody(msg.body || '')}
                </p>
              )}

              {/* reactions */}
              {counts.length || pickerOpen ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {counts.map((rc) => {
                    const reacted =
                      !!currentUser &&
                      rc.users.some((u) => u.toLowerCase() === currentUser.toLowerCase());
                    return (
                      <button
                        key={rc.emoji}
                        type="button"
                        disabled={!canComment || busy}
                        onClick={() => onReact(msg.id, rc.emoji, reacted)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                          reacted
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted',
                          !canComment && 'cursor-default',
                        )}
                        aria-pressed={reacted}
                        aria-label={`${rc.emoji} ${rc.users.length}`}
                      >
                        {/* UNTRUSTED emoji — plain text. */}
                        <span>{rc.emoji}</span>
                        <span className="tabular-nums">{rc.users.length}</span>
                      </button>
                    );
                  })}
                  {pickerOpen
                    ? QUICK_EMOJI.map((e) => (
                        <button
                          key={e}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            onReact(msg.id, e, false);
                            setPickerOpen(false);
                          }}
                          className="rounded-full border border-border bg-card px-2 py-0.5 text-xs hover:bg-muted"
                        >
                          {e}
                        </button>
                      ))
                    : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* actions */}
        {!deleted && !editing && canComment ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 pl-1">
            {!nested ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() => setReplyingTo((v) => !v)}
              >
                <Reply className="h-3.5 w-3.5" /> Reply
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
              onClick={() => setPickerOpen((v) => !v)}
            >
              <SmilePlus className="h-3.5 w-3.5" /> React
            </Button>
            {mine ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-critical"
                  onClick={() => onDelete(msg.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        {/* reply composer */}
        {replyingTo && canComment ? (
          <div className="mt-2 flex items-start gap-2 pl-1">
            <CornerDownRight className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex-1">
              <ThreadComposer
                users={users}
                /* eslint-disable-next-line jsx-a11y/no-autofocus -- deliberate focus placement on the primary field of a focused dialog/login flow; behavior-preserving */
                autoFocus
                submitLabel="Reply"
                busy={busy}
                placeholder={`Reply to ${name}…`}
                onCancel={() => setReplyingTo(false)}
                onSubmit={(text) => {
                  onReply(msg.id, text);
                  setReplyingTo(false);
                }}
              />
            </div>
          </div>
        ) : null}

        {/* nested replies (one level) */}
        {replies.length ? (
          <div className="mt-2 space-y-2 border-l-2 border-border/60 pl-3">
            {replies.map((r) => (
              <MessageItem
                key={r.id}
                msg={r}
                replies={[]}
                users={users}
                currentUser={currentUser}
                canComment={canComment}
                busyId={busyId}
                onReply={onReply}
                onEdit={onEdit}
                onDelete={onDelete}
                onReact={onReact}
                nested
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/* ----------------------------------------------------------- visible count -- */

/**
 * The number of messages the thread actually RENDERS — i.e. every message EXCEPT a
 * tombstoned ROOT that has no replies (those are dropped as nothing-useful-to-show;
 * a tombstoned root WITH replies still renders as a placeholder to anchor them).
 *
 * Exported so the Discussion badge in CaseDetail counts the exact same set the list
 * renders (see {@link CaseThread}'s `visibleRoots`) — the two must never drift.
 */
export function visibleMessageCount(messages: CaseMessage[]): number {
  // Roots (no parent) + how many DIRECT children each id has. The list renders roots
  // and their one-level replies only: nested MessageItems get `replies={[]}`, so a
  // deeper-than-one-level reply (parent is itself a reply) and an orphaned reply (parent
  // absent from `messages`) are never rendered — and must not be counted here.
  const rootIds = new Set<string>();
  const directReplies = new Map<string, number>();
  for (const m of messages) {
    if (m.parent_id) directReplies.set(m.parent_id, (directReplies.get(m.parent_id) ?? 0) + 1);
    else rootIds.add(m.id);
  }
  let count = 0;
  for (const m of messages) {
    if (!m.parent_id) {
      // A parentless tombstone with no replies is hidden; every other root renders
      // (live roots, and tombstoned roots that still anchor a reply as a placeholder).
      const tombstoned = Boolean(m.deleted || m.deleted_at);
      if (tombstoned && !(directReplies.get(m.id) ?? 0)) continue;
      count += 1;
    } else if (rootIds.has(m.parent_id)) {
      // A direct reply under a rendered root. Deeper/orphaned replies are not rendered.
      count += 1;
    }
  }
  return count;
}

/* --------------------------------------------------------------- component -- */

export interface CaseThreadProps {
  messages: CaseMessage[];
  users: PickableUser[];
  currentUser: string | null;
  /** Whether the caller holds cases:comment (mounts the composer + write controls). */
  canComment: boolean;
  /** A message id currently being mutated (disables its controls). */
  busyId?: string | null;
  /** Post a root message. */
  onPost: (text: string) => void;
  onReply: (parentId: string, text: string) => void;
  onEdit: (msgId: string, text: string) => void;
  onDelete: (msgId: string) => void;
  onReact: (msgId: string, emoji: string, remove: boolean) => void;
  className?: string;
  /**
   * Optional: the case id to subscribe to for LIVE `case.activity` frames. When set
   * (and realtime is enabled on the backend), a teammate's/AI's new message nudges the
   * caller to refetch. Omitted by default → no stream, today's polling behaviour.
   */
  liveCaseId?: string;
  /**
   * Called when a live `case.activity` frame arrives for `liveCaseId`. The caller
   * should refetch the authoritative thread. Only fires when `liveCaseId` is set.
   */
  onLiveActivity?: () => void;
}

/**
 * The case thread: a chronological root list (each with its one-level replies), plus
 * a root composer when the caller can comment. Pure presentation — all mutations are
 * delegated to the caller's handlers (which call the API + refresh).
 */
export const CaseThread: React.FC<CaseThreadProps> = ({
  messages,
  users,
  currentUser,
  canComment,
  busyId = null,
  onPost,
  onReply,
  onEdit,
  onDelete,
  onReact,
  className,
  liveCaseId,
  onLiveActivity,
}) => {
  // Live nudge: a `case.activity` frame on this case's room → ask the caller to refetch
  // the thread. The frame payload is never rendered here (#9) — it only triggers a load.
  const onEvent = React.useCallback(
    (ev: { type: string }) => {
      if (ev.type === 'case.activity') onLiveActivity?.();
    },
    [onLiveActivity],
  );
  useEventStream(liveCaseId ? [`cases:${liveCaseId}`] : [], {
    enabled: Boolean(liveCaseId),
    onEvent,
  });

  // Partition into roots + replies-by-parent, preserving chronological order.
  const { roots, repliesByParent } = React.useMemo(() => {
    const sorted = [...messages].sort(
      (a, b) => Date.parse(a.created_at || '') - Date.parse(b.created_at || ''),
    );
    const repliesMap = new Map<string, CaseMessage[]>();
    const rootList: CaseMessage[] = [];
    for (const m of sorted) {
      if (m.parent_id) {
        const list = repliesMap.get(m.parent_id) || [];
        list.push(m);
        repliesMap.set(m.parent_id, list);
      } else {
        rootList.push(m);
      }
    }
    return { roots: rootList, repliesByParent: repliesMap };
  }, [messages]);

  // Drop a root that is tombstoned AND has no replies (nothing useful to show).
  const visibleRoots = roots.filter(
    (r) => !((r.deleted || r.deleted_at) && !(repliesByParent.get(r.id) || []).length),
  );

  return (
    <div className={cn('space-y-4', className)}>
      {visibleRoots.length === 0 ? (
        <EmptyState
          icon={UserIcon}
          compact
          title="No discussion yet"
          description={
            canComment
              ? 'Start the conversation. The AI assistant and your teammates appear here together.'
              : 'No messages have been posted on this case yet.'
          }
        />
      ) : (
        <div className="space-y-5">
          {visibleRoots.map((m) => (
            <MessageItem
              key={m.id}
              msg={m}
              replies={repliesByParent.get(m.id) || []}
              users={users}
              currentUser={currentUser}
              canComment={canComment}
              busyId={busyId}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
            />
          ))}
        </div>
      )}

      {canComment ? (
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Check className="h-3 w-3" aria-hidden />
            New message
          </div>
          <ThreadComposer
            users={users}
            busy={busyId === '__post__'}
            onSubmit={onPost}
            placeholder="Share findings or a hand-off… use @ to mention a teammate (⌘/Ctrl+Enter to post)"
          />
        </div>
      ) : null}
    </div>
  );
};

export default CaseThread;
