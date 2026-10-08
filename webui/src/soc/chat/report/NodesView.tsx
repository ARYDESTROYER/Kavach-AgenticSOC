/**
 * React rendering of the walker's document nodes (chat revamp SPEC §9.3): the report
 * document's header, summary, methodology and appendix on screen and in the print
 * portal come from the SAME nodes the Markdown and HTML exporters serialise, so the
 * three surfaces say exactly the same thing.
 *
 * Every string is a React text node (G1); class names come from enums only (G2); the
 * one external link is the ATT&CK page constructed from a validated technique id.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { CodeBlock } from '@/soc/components/CodeBlock';

import { ChatMarkdown } from '../ChatMarkdown';
import type { ToneKey } from '../blocks/schema';
import type { DocNode, Line } from './export/walker';

const TONE_CLASS: Record<ToneKey, string> = {
  info: 'border-l-info',
  success: 'border-l-info',
  warning: 'border-l-warning',
  critical: 'border-l-critical',
};

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-semibold tracking-tight text-foreground',
  2: 'mt-6 border-t border-border pt-4 text-base font-semibold text-foreground first:mt-0 first:border-0 first:pt-0',
  3: 'mt-4 text-sm font-semibold text-foreground',
};

function LineView({ line }: { line: Line }) {
  return (
    <>
      {line.map((run, i) =>
        run.code ? (
          <code key={i} className="break-all rounded bg-muted px-1 font-mono text-xs">
            {run.text}
          </code>
        ) : run.strong ? (
          <strong key={i}>{run.text}</strong>
        ) : (
          <React.Fragment key={i}>{run.text}</React.Fragment>
        ),
      )}
    </>
  );
}

function Heading({ level, children }: { level: number; children: React.ReactNode }) {
  const lvl = Math.max(1, Math.min(6, level));
  const Tag = `h${lvl}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  return <Tag className={HEADING_CLASS[Math.min(3, lvl)] ?? HEADING_CLASS[3]}>{children}</Tag>;
}

export interface NodesViewProps {
  nodes: readonly DocNode[];
  /** Added to every heading level (the library page's own h1 shifts the document by 1). */
  shift?: number;
  className?: string;
}

/** Render document nodes as plain, token-styled React. */
export function NodesView({ nodes, shift = 0, className }: NodesViewProps) {
  return (
    <div className={cn('min-w-0 space-y-2 text-sm text-foreground', className)}>
      {nodes.map((node, i) => {
        switch (node.k) {
          case 'heading':
            return (
              <Heading key={i} level={node.level + shift}>
                {node.text}
              </Heading>
            );
          case 'meta':
            return (
              <p key={i} className="text-xs text-muted-foreground">
                {node.text}
              </p>
            );
          case 'para':
            return (
              <p key={i} className={cn('leading-relaxed', node.muted && 'text-muted-foreground')}>
                <LineView line={node.line} />
              </p>
            );
          case 'md':
            // ChatMarkdown renders rank 1 at headingBase + 1.
            return <ChatMarkdown key={i} text={node.text} headingBase={Math.max(1, Math.min(5, node.base + shift - 1))} />;
          case 'table':
            return (
              <div key={i} className="max-w-full overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface">
                      {node.head.map((h, c) => (
                        <th
                          key={c}
                          scope="col"
                          className={cn('px-3 py-1.5 text-xs font-semibold text-muted-foreground', node.numeric[c] ? 'text-right' : 'text-left')}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {node.rows.map((row, r) => (
                      <tr key={r} className="border-b border-border/60 last:border-0">
                        {row.map((cell, c) => (
                          <td
                            key={c}
                            className={cn(
                              'px-3 py-1 align-top',
                              node.numeric[c] && 'text-right tabular-nums',
                              (node.cellCode?.[r]?.[c] ?? node.code[c]) && cell !== '—' && 'break-all font-mono text-xs',
                            )}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'list': {
            const items = node.items.map((line, li) => (
              <li key={li} className="pl-0.5">
                <LineView line={line} />
              </li>
            ));
            return node.ordered ? (
              <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
                {items}
              </ol>
            ) : (
              <ul key={i} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
                {items}
              </ul>
            );
          }
          case 'code':
            return <CodeBlock key={i} value={node.text} caption={node.caption ?? undefined} wrap maxHeightClassName="max-h-96" />;
          case 'callout':
            return (
              <div
                key={i}
                role="note"
                className={cn('whitespace-pre-wrap rounded-md border border-l-4 border-border bg-surface px-3 py-2 text-sm', TONE_CLASS[node.tone])}
              >
                <span className="font-semibold">{node.label}: </span>
                {node.text}
              </div>
            );
          case 'attack':
            return (
              <ul key={i} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
                {node.items.map((t) => (
                  <li key={t.id}>
                    {t.url ? (
                      <a
                        href={t.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-primary underline underline-offset-2"
                      >
                        {t.id}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{t.id}</span>
                    )}
                    {t.label ? ` ${t.label}` : null}
                  </li>
                ))}
              </ul>
            );
          case 'rule':
            return <hr key={i} className="my-4 border-border" />;
          default:
            return null;
        }
      })}
    </div>
  );
}
