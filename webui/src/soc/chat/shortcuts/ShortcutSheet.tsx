/**
 * ShortcutSheet — the Ctrl/Cmd+/ keyboard shortcut reference (SPEC §10.4a).
 *
 * Renders every entry of {@link CHAT_SHORTCUTS} — the composer keys (Enter,
 * Shift+Enter, ↑, Esc, /, @) and the page shortcuts — as a two-column definition
 * list with `<kbd>` keys, in the platform's notation (⌘ on macOS). A Radix dialog:
 * focus moves in, Esc closes it, and focus returns to the opener.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/ui/dialog';
import { CHAT_SHORTCUTS, isApplePlatform, keyLabel, type ChatShortcut } from './shortcut-list';

export interface ShortcutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const GROUPS: { where: ChatShortcut['where']; title: string }[] = [
  { where: 'composer', title: 'In the composer' },
  { where: 'chat', title: 'Anywhere in Chat' },
];

function Keys({ shortcut, apple }: { shortcut: ChatShortcut; apple: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {shortcut.keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-2xs text-foreground"
        >
          {keyLabel(key, apple)}
        </kbd>
      ))}
    </span>
  );
}

export function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps) {
  const apple = isApplePlatform();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>{apple ? '⌘ is the Command key.' : 'Ctrl is the Control key.'}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {GROUPS.map((group) => {
            const headingId = `chat-shortcuts-${group.where}`;
            return (
              <section key={group.where} aria-labelledby={headingId}>
                <h3 id={headingId} className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {group.title}
                </h3>
                <dl className="divide-y divide-border">
                  {CHAT_SHORTCUTS.filter((s) => s.where === group.where).map((shortcut) => (
                    <div key={shortcut.id} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                      <dt className="min-w-0 text-foreground">
                        {shortcut.label}
                        {shortcut.note ? <span className="text-muted-foreground"> ({shortcut.note})</span> : null}
                      </dt>
                      <dd>
                        <Keys shortcut={shortcut} apple={apple} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
