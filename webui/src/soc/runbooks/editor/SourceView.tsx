/**
 * The "Source" view (Round 14, SPEC §4.10.12, §4.10.13): the runbook's Markdown, editable.
 * The text is parsed as it changes (the client mirror of the server's parser) and the
 * outline follows; the server validates the same text, and a save from this view sends the
 * Markdown itself so the server reads it authoritatively. "Chips and front matter are the
 * same fields; edit either."
 *
 * The text is shown in a plain textarea (never rendered as HTML, #9).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { RunbookIssue } from '@/lib/types-runbooks';
import { Label } from '@/ui/label';

import { RUNBOOK_LIMITS } from '../shared/labels';

export interface SourceViewProps {
  value: string;
  onChange?: (text: string) => void;
  readOnly: boolean;
  /** Problems the parser or the server found in this text. */
  issues: RunbookIssue[];
  /** The outline is showing the last text that read correctly, not this one. */
  stale: boolean;
  className?: string;
}

const LINE_HEIGHT_REM = 1.375;

export function SourceView({ value, onChange, readOnly, issues, stale, className }: SourceViewProps) {
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const lines = React.useMemo(() => Math.max(1, value.split('\n').length), [value]);
  const bytes = React.useMemo(() => new TextEncoder().encode(value).length, [value]);
  const id = React.useId();
  const issuesId = `${id}-issues`;
  const noteId = `${id}-note`;

  const syncScroll = () => {
    if (gutterRef.current && textRef.current) gutterRef.current.scrollTop = textRef.current.scrollTop;
  };

  return (
    <section aria-label="Markdown source" className={cn('min-w-0 space-y-3', className)} data-source-view="">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Label htmlFor={`${id}-text`} className="text-sm font-medium text-foreground">
          Markdown
        </Label>
        <span className={cn('text-xs tabular-nums', bytes > RUNBOOK_LIMITS.sourceBytes ? 'text-critical-text' : 'text-muted-foreground')}>
          {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'} · {bytes.toLocaleString()} of {RUNBOOK_LIMITS.sourceBytes.toLocaleString()} bytes
        </span>
      </div>
      <p id={noteId} className="text-sm text-muted-foreground">
        {readOnly
          ? 'The same runbook as the outline, in its Markdown form.'
          : 'Chips and front matter are the same fields; edit either. The outline follows as you type.'}
      </p>
      {stale && !readOnly ? (
        <p role="status" className="text-sm text-warning-text">
          This text has problems, so the outline shows the last version that read correctly.
        </p>
      ) : null}
      <div className="flex min-w-0 overflow-hidden rounded-lg border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
        <div
          ref={gutterRef}
          aria-hidden
          className="select-none overflow-hidden border-r border-border/70 bg-muted/40 px-2 py-2 text-right font-mono text-xs text-muted-foreground"
          style={{ lineHeight: `${LINE_HEIGHT_REM}rem`, maxHeight: '70vh' }}
        >
          {Array.from({ length: lines }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textRef}
          id={`${id}-text`}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onScroll={syncScroll}
          onChange={(e) => onChange?.(e.target.value)}
          aria-describedby={[noteId, issues.length ? issuesId : null].filter(Boolean).join(' ')}
          aria-invalid={issues.length ? true : undefined}
          className="min-h-[24rem] w-full min-w-0 flex-1 resize-y bg-transparent px-3 py-2 font-mono text-xs text-foreground outline-none"
          style={{ lineHeight: `${LINE_HEIGHT_REM}rem`, maxHeight: '70vh' }}
          data-source-text=""
        />
      </div>
      {issues.length ? (
        <ul id={issuesId} className="space-y-0.5" aria-label="Problems in the Markdown">
          {issues.slice(0, 50).map((issue, i) => (
            <li key={i} className="text-sm text-critical-text [overflow-wrap:anywhere]">
              {issue.message}
            </li>
          ))}
          {issues.length > 50 ? (
            <li className="text-sm text-muted-foreground">{`And ${(issues.length - 50).toLocaleString()} more.`}</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
