/**
 * The Explain panel: the full arithmetic of one number (Round 16 SPEC §4.5 WP11; research
 * explainability §5.1).
 *
 * Result, formula, inputs (name, value, where it came from), the steps (each arithmetic
 * line), rounding, provenance and caveats, then "Copy calculation" and an optional link
 * to the records. Every value is rendered as a text node, never markup (#9): a rule name,
 * an entity value or a model name prints literally.
 */
import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { PROVENANCE_WORDS, explanationText, summaryWithoutHint } from '@/lib/explain/text';
import type { Explanation, ExplanationLink } from '@/lib/explain/types';

/** A Console hash link for an explanation's records link (`#/cases?status=open`). */
export function explainLinkHref(link: ExplanationLink): string {
  const query = new URLSearchParams(link.params).toString();
  return `#/${link.route.replace(/^[#/]+/, '')}${query ? `?${query}` : ''}`;
}

const PROVENANCE_TONE: Record<Explanation['provenance'], string> = {
  recorded: 'text-success-text',
  server_computed: 'text-foreground',
  reconstructed_current: 'text-warning-text',
  not_recorded: 'text-warning-text',
};

const SECTION_LABEL = 'text-xs font-medium text-muted-foreground';

export interface ExplainPanelProps {
  explanation: Explanation;
  /** A component's own content, after the steps. */
  detail?: React.ReactNode;
  /** The heading's id, so the popover can name itself by it. */
  titleId?: string;
  className?: string;
}

export function ExplainPanel({ explanation, detail, titleId, className }: ExplainPanelProps) {
  const [copied, setCopied] = React.useState<'idle' | 'done' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = React.useCallback(() => {
    void copyText(explanationText(explanation)).then((ok) => {
      setCopied(ok ? 'done' : 'failed');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied('idle'), 1500);
    });
  }, [explanation]);
  const title = explanation.title ?? explanation.metric;

  return (
    <div className={cn('space-y-3 text-xs', className)} data-testid="explain-panel" data-metric={explanation.metric}>
      <div className="space-y-1">
        <p id={titleId} className={SECTION_LABEL}>
          {title}
        </p>
        <p className="text-base font-semibold tabular-nums text-foreground" data-testid="explain-result">
          {explanation.display}
        </p>
        <p className="leading-relaxed text-foreground/90" data-testid="explain-summary">
          {summaryWithoutHint(explanation.summary)}
        </p>
      </div>

      <div className="space-y-1 border-t border-border/70 pt-2.5">
        <p className={SECTION_LABEL}>Formula</p>
        <p className="break-words font-mono text-foreground">{explanation.formula}</p>
      </div>

      {explanation.inputs.length ? (
        <div className="space-y-1 border-t border-border/70 pt-2.5">
          <p className={SECTION_LABEL}>Inputs</p>
          <dl className="space-y-1.5" data-testid="explain-inputs">
            {explanation.inputs.map((input) => (
              <div key={input.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3">
                <dt className="text-muted-foreground">{input.label}</dt>
                <dd className="min-w-0 break-words text-foreground">
                  <span className="tabular-nums">{input.value}</span>
                  {input.source ? <span className="block text-muted-foreground">{input.source}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {explanation.steps.length ? (
        <div className="space-y-1 border-t border-border/70 pt-2.5">
          <p className={SECTION_LABEL}>Steps</p>
          <table className="w-full table-fixed border-collapse text-left" data-testid="explain-steps">
            <caption className="sr-only">{`How ${title} is calculated`}</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Calculation</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {explanation.steps.map((step, index) => (
                <tr key={`${step.label}-${index}`} className="align-top">
                  <th scope="row" className="w-24 py-1 pr-2 font-normal text-muted-foreground">
                    {step.label}
                  </th>
                  <td className="break-words py-1 pr-2 font-mono text-foreground/90">{step.expression}</td>
                  <td className="w-24 break-words py-1 text-right font-mono tabular-nums text-foreground">{step.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {detail ? <div className="border-t border-border/70 pt-2.5">{detail}</div> : null}

      {explanation.rounding ? (
        <div className="space-y-1 border-t border-border/70 pt-2.5">
          <p className={SECTION_LABEL}>Rounding</p>
          <p className="leading-relaxed text-foreground/90">{explanation.rounding}</p>
        </div>
      ) : null}

      <div className="space-y-1 border-t border-border/70 pt-2.5">
        <p className={SECTION_LABEL}>Provenance</p>
        <p className={cn('leading-relaxed', PROVENANCE_TONE[explanation.provenance])} data-testid="explain-provenance">
          {explanation.provenanceNote ?? PROVENANCE_WORDS[explanation.provenance]}
        </p>
      </div>

      {explanation.caveats.length ? (
        <ul className="space-y-1 border-t border-border/70 pt-2.5 leading-relaxed text-muted-foreground" data-testid="explain-caveats">
          {explanation.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 pt-2.5">
        <button
          type="button"
          onClick={copy}
          className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-border px-2 font-medium text-foreground transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied === 'done' ? <Check className="size-3.5 text-success-text" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied === 'done' ? 'Copied' : 'Copy calculation'}
        </button>
        {explanation.link ? (
          <a
            href={explainLinkHref(explanation.link)}
            className="rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {explanation.link.label}
          </a>
        ) : null}
        <span role="status" className="sr-only">
          {copied === 'done' ? 'Calculation copied.' : copied === 'failed' ? 'The calculation could not be copied.' : ''}
        </span>
        {copied === 'failed' ? <span className="text-critical-text">Could not copy.</span> : null}
      </div>
    </div>
  );
}
