/**
 * "Why attached" (Round 14, SPEC §4.10.4, §4.10.11): the stored, deterministic reason a
 * runbook is on the case, in a 24rem popover from the runbook strip. The matched
 * criteria, every criterion that was checked, the pinned version, and the selection rules
 * behind "How matching works".
 *
 * The explanation was written by the matcher when the run attached; it is shown as it was
 * stored (rule names and tags are case data, rendered as text nodes, #9). Matching never
 * changes the verdict, the status or the close decision (#3).
 */
import * as React from 'react';
import { Check, ChevronDown, Info, Minus } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import type { MatchedCriterion, MatchValue, RunbookRun } from '@/lib/types-runbooks';
import {
  CASE_STATUS_WORD,
  CRITERION_LABEL,
  ENTITY_TYPE_LABEL,
  SEVERITY_WORD,
  VERDICT_WORD,
  describeExplanation,
  missedSentence,
  TIER_LABEL,
  Mono,
} from '@/soc/runbooks/shared';
import type { RunbookEntityType, RunbookVerdict, SeverityLevel } from '@/lib/types-runbooks';

import { actorName, attachNote, attachedLine, isMatchExplanation, utcTime, type NameOf } from './model';

const CODE_CRITERIA = new Set(['rule_ids', 'mitre', 'any_tags', 'sources']);

function values(value: MatchValue): string[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

/** One matched criterion's value, as identifiers or words. */
function MatchedValue({ item }: { item: MatchedCriterion }) {
  const list = values(item.value);
  if (CODE_CRITERIA.has(item.criterion)) {
    return (
      <span className="flex flex-wrap gap-1">
        {list.map((v, i) => (
          <Mono key={`${v}-${i}`}>{item.criterion === 'sources' && v.startsWith('type:') ? `type ${v.slice(5)}` : v}</Mono>
        ))}
      </span>
    );
  }
  let text: string;
  switch (item.criterion) {
    case 'entity_types':
      text = list.map((v) => ENTITY_TYPE_LABEL[v as RunbookEntityType] ?? v).join(', ');
      break;
    case 'severity_at_least':
      text = `${SEVERITY_WORD[list[0] as SeverityLevel] ?? list[0] ?? ''} or higher`;
      break;
    case 'verdicts':
      text = list.map((v) => VERDICT_WORD[v as RunbookVerdict] ?? v).join(', ');
      break;
    case 'statuses':
      text = list.map((v) => CASE_STATUS_WORD[v] ?? v).join(', ');
      break;
    case 'min_event_count': {
      const count = Number(list[0] ?? 0) || 0;
      text = `At least ${count.toLocaleString()} events`;
      break;
    }
    case 'always':
      text = 'Any case that needs a person';
      break;
    default:
      text = list.join(', ');
  }
  return <span className="text-foreground">{text}</span>;
}

export interface WhyAttachedContentProps {
  run: RunbookRun;
  /** The newer published version, when one exists. */
  newerVersion?: number | null;
  nameOf?: NameOf;
  now?: Date;
}

export function WhyAttachedContent({ run, newerVersion = null, nameOf, now = new Date() }: WhyAttachedContentProps) {
  const [how, setHow] = React.useState(false);
  const howId = React.useId();
  const reason = run.attached_reason;
  const explanation = isMatchExplanation(reason) ? reason : null;
  const note = attachNote(run);
  const who = actorName(run.attached_actor, nameOf);
  let summary: string;
  if (run.attached_by === 'person') summary = `Added by ${who}.`;
  else if (run.attached_by === 'suggestion') summary = `Suggested by the AI, accepted by ${who}.`;
  else summary = describeExplanation(explanation);

  return (
    <div className="space-y-3" data-why-attached="">
      <div>
        <p className="text-sm font-semibold text-foreground">Why this runbook is attached</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {summary}
          {explanation && run.attached_by !== 'person' && run.attached_by !== 'suggestion' ? (
            <span className="block">{TIER_LABEL[explanation.tier]}</span>
          ) : null}
        </p>
        {note ? (
          <p className="mt-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs text-foreground">
            <span className="text-muted-foreground">Note: </span>
            {note}
          </p>
        ) : null}
      </div>

      {explanation && (explanation.matched.length || explanation.missed.length) ? (
        <ul className="space-y-1.5" aria-label="Criteria">
          {explanation.matched.map((item, i) => (
            <li key={`m-${item.criterion}-${i}`} className="grid grid-cols-[1rem_6rem_minmax(0,1fr)] items-start gap-x-2 text-sm">
              <Check className="mt-0.5 size-4 text-success-text" aria-hidden />
              <span className="text-muted-foreground">
                {CRITERION_LABEL[item.criterion]}
                <span className="sr-only">, matched</span>
              </span>
              <span className="min-w-0">
                <MatchedValue item={item} />
              </span>
            </li>
          ))}
          {explanation.missed.map((item, i) => (
            <li key={`x-${item.criterion}-${i}`} className="grid grid-cols-[1rem_6rem_minmax(0,1fr)] items-start gap-x-2 text-sm">
              <Minus className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">
                {CRITERION_LABEL[item.criterion]}
                <span className="sr-only">, not matched</span>
              </span>
              <span className="min-w-0 text-xs text-muted-foreground">{missedSentence(item)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
        <p>
          {attachedLine(run, nameOf, now)}. This case keeps version {run.version.toLocaleString()} even if a newer
          version is published.
          {newerVersion ? ` Version ${newerVersion.toLocaleString()} is published; Switch version in the menu moves this run to it.` : ''}
        </p>
        {run.completed_at ? <p>Completed at {utcTime(run.completed_at, now)}.</p> : null}
        <p className="font-medium text-foreground">Matching never changes the verdict, the status or the close decision.</p>
      </div>

      <div className="border-t border-border pt-2">
        <button
          type="button"
          aria-expanded={how}
          aria-controls={howId}
          onClick={() => setHow((v) => !v)}
          className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs font-medium text-secondary-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className={cn('size-3.5 transition-transform duration-fast', how && 'rotate-180')} aria-hidden />
          How matching works
        </button>
        <div id={howId} hidden={!how} className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <p>
            The most specific match wins: a rule match beats a technique match, which beats other conditions. Then
            the higher priority, then the most conditions matched, then the newest published version.
          </p>
          <p>When nothing else matches, Generic incident (NIST 800-61) attaches as the fallback, if the fallback is on.</p>
          <p>Only published runbooks match. Drafts and runbooks in review never attach.</p>
          {explanation?.tie ? <p>More than one runbook matched equally here; the first by name was chosen.</p> : null}
        </div>
      </div>
    </div>
  );
}

/** The strip's "Why attached" control: a text button, or an icon button on a narrow pane. */
export function WhyAttachedButton({
  iconOnly = false,
  ...props
}: WhyAttachedContentProps & { iconOnly?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        {iconOnly ? (
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="Why attached">
            <Info aria-hidden />
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground">
            <Info aria-hidden />
            Why attached
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={iconOnly ? 'end' : 'start'}
        sideOffset={6}
        // The phone layout's 16px side gutter holds for the popover too.
        collisionPadding={16}
        className="w-[min(24rem,calc(100vw-2rem))]"
      >
        <WhyAttachedContent {...props} />
      </PopoverContent>
    </Popover>
  );
}
