/**
 * ComposerMenu — the `/` and `@` menus' list, built on the shared cmdk primitive
 * (`src/ui/command.tsx`, SPEC §10.4).
 *
 * Focus never leaves the textarea: the composer filters the items itself
 * (`shouldFilter={false}`), drives the highlighted item through cmdk's controlled
 * `value`, and points the textarea's `aria-activedescendant` at it (the composer reads
 * the rendered option ids back through {@link onListRendered}). Denied scopes stay
 * listed but disabled, with the permission that would unlock them.
 */
import * as React from 'react';
import { AtSign, Bookmark, FileText, Library, ListOrdered, Lock, Slash, Sparkles, Star } from 'lucide-react';
import { Command, CommandGroup, CommandItem, CommandList } from '@/ui/command';
import type { ComposerMenuGroup, ComposerMenuItem } from './commands';
import { isPromptbook } from './prompt-library';

export interface ComposerMenuProps {
  kind: 'slash' | 'at';
  groups: ComposerMenuGroup[];
  active: string;
  onActiveChange: (value: string) => void;
  onChoose: (item: ComposerMenuItem) => void;
  /** Called after each render with the list element (for aria-controls/activedescendant). */
  onListRendered?: (list: HTMLElement | null) => void;
}

function ItemIcon({ item }: { item: ComposerMenuItem }) {
  if (item.kind === 'scope') return item.disabled ? <Lock aria-hidden="true" /> : <AtSign aria-hidden="true" />;
  if (item.kind === 'prompt') {
    if (isPromptbook(item.prompt)) return <ListOrdered aria-hidden="true" />;
    if (item.prompt.starter) return <Sparkles aria-hidden="true" />;
    return item.prompt.favorite ? <Star aria-hidden="true" /> : <Bookmark aria-hidden="true" />;
  }
  if (item.kind === 'library') return <Library aria-hidden="true" />;
  if (item.kind === 'report') return <FileText aria-hidden="true" />;
  return <Slash aria-hidden="true" />;
}

export function ComposerMenu({ kind, groups, active, onActiveChange, onChoose, onListRendered }: ComposerMenuProps) {
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    onListRendered?.(listRef.current);
  });
  return (
    <Command shouldFilter={false} value={active} onValueChange={onActiveChange} className="rounded-[3px]">
      <CommandList ref={listRef} label={kind === 'slash' ? 'Commands' : 'Scopes'} className="max-h-72 p-1">
        {groups.map((group) => (
          <CommandGroup key={group.heading} heading={group.heading} className="p-0">
            {group.items.map((item) => {
              const disabled = item.kind === 'scope' && item.disabled;
              return (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  disabled={disabled}
                  onSelect={() => onChoose(item)}
                  className="gap-2.5 py-1.5"
                >
                  <ItemIcon item={item} />
                  <span
                    className={
                      item.kind === 'command' || item.kind === 'report' || item.kind === 'scope'
                        ? 'shrink-0 font-mono text-xs text-foreground'
                        : 'max-w-[45%] shrink-0 truncate text-foreground'
                    }
                  >
                    {item.label}
                  </span>
                  <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">{item.hint}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-2xs text-muted-foreground" aria-hidden="true">
        <span>↑↓ move</span>
        <span>Enter choose</span>
        <span>Esc close</span>
      </div>
    </Command>
  );
}
