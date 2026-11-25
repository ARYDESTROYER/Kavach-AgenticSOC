/**
 * One line of release-note text with the two marks the generator allows: `**bold**` and
 * `` `code` ``. Every part is a React text node or element; nothing is ever parsed as
 * markup, so even a value that slipped past the generator renders as plain text.
 */
import * as React from 'react';

export function InlineText({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={index} className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={index} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}
